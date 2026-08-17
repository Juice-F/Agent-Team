import type {
  Agent,
  AgentJob,
  Inbound,
  StepContext,
  StepResult,
  WorkflowStage,
} from "../types.js";
import type { CardAction } from "../feishu/index.js";
import { generateCard } from "../feishu/card.js";
import { CardChoiceSchema, WorkflowStageSchema } from "../schema.js";
import {
  acquireThread,
  pendingCount,
  popPending,
  pushPending,
  threadBusy,
  type Lease,
  type PendingEvent,
} from "../redis/queue.js";
import { claim } from "../redis/once.js";
import type { Session, SessionStore } from "../postgres/session.js";
import type { Workflow } from "./graph.js";

/** 被 interrupt() 打断，不是自己跑挂的 */
export class Interrupted extends Error {}

export class Runner {
  private readonly inflight = new Map<string, AbortController>();
  private sessionStore!: SessionStore;

  constructor(private readonly workflow: Workflow) {}

  async start(store: SessionStore): Promise<Session[]> {
    this.sessionStore = store;
    await Promise.all(this.workflow.agents.map((agent) => agent.start(this)));
    return this.recover();
  }

  /**
   * 话题里来了一条待办：排进这个话题的队列，然后试着抢锁开跑。
   *
   * msg：被上一棒推起来的、启动捡漏的都是 null
   * stage：打字进来的消息没是 null
   */
  async deliver(
    job: AgentJob,
    threadId: string,
    msg: Inbound | null,
    stage: WorkflowStage | null = null,
  ): Promise<void> {
    const task = await this.sessionStore.load(threadId);
    if (!task) return;
    if (this.workflow.ownerOf(task.stage) !== job) return;

    await pushPending(threadId, { msg, stage, job } satisfies PendingEvent);

    const lease = await acquireThread(threadId);
    if (!lease) {
      // 只对着人说「我正忙」：交棒的 @ 消息、启动捡漏的那条都不是人在说话
      if (msg && !msg.fromBot) await this.hintBusy(task, msg);
      return;
    }
    
    await this.drain(lease, threadId);
  }

  /**
   * 话题里点了卡片上的按钮。
   *
   * 点一下等同于在话题里说了按钮上那句话，所以翻成一条消息走跟打字一模一样的
   * 路。返回的话会弹给点按钮的人看。
   *
   */
  async click(job: AgentJob, action: CardAction): Promise<string> {
    const parsed = CardChoiceSchema.safeParse(action.value);
    if (!parsed.success) return "这个按钮的参数不对，可能是旧版本发的卡片";
    const choice = parsed.data;

    const task = await this.sessionStore.load(choice.threadId);
    if (!task) return "找不到这个任务";
    if (this.workflow.ownerOf(task.stage) !== job) return "这一步已经不归我管了";
    if (task.stage !== choice.stage) {
      return `任务已经走到「${this.workflow.at(task.stage).label}」，这张卡片过期了`;
    }

    const message: Inbound = {
      text: choice.text,
      messageId: action.messageId,
      chatId: action.chatId,
      fromBot: false,
      confirmed: choice.confirm,
      // 用户填的盖住按钮上写死的：同一个名字，他填的那份才是他眼前看到的
      data: { ...choice.data, ...action.formValue },
    };

    // 不 await：飞书等着这个响应，那一棒可能要跑很久，挂到后面去
    void this.deliver(job, choice.threadId, message, choice.stage).catch(
      (err: unknown) => {
        console.error(`[click] ${task.id} ${task.stage}`, err);
      },
    );

    return "收到";
  }

  // 打断这个话题上正在跑的那一棒 
  interrupt(threadId: string, reason = "外部中断"): boolean {
    const control = this.inflight.get(threadId);
    if (!control) return false;
    control.abort(new Interrupted(reason));
    return true;
  }

  // 全打断，退出前用
  interruptAll(reason = "进程退出"): number {
    const threads = [...this.inflight.keys()];
    for (const threadId of threads) this.interrupt(threadId, reason);
    return threads.length;
  }

  /**
   * 启动时把中断在半路的任务捡回来。
   *
   * `running` 在多副本下有两种相反的意思：上个进程死在半路留下的，和**另一个副本
   * 此刻正跑着**的。分不出来就会在滚动发布时把人家手里的活抢过来重跑一遍——两个
   * `claude -p` 同时改同一份代码。
   *
   * 锁就是这两者的分界线：有人在续租，说明它活着，跳过。
   */
  private async recover(): Promise<Session[]> {
    // phase 那一半的过滤下推到 SQL 了，这儿只剩「这个阶段有没有人认领」
    const stuck = (await this.sessionStore.listActive()).filter((task) =>
      this.workflow.ownerOf(task.stage),
    );

    const mine: Session[] = [];
    for (const task of stuck) {
      const job = this.workflow.ownerOf(task.stage);
      if (!job) continue;
      if (await threadBusy(task.threadId)) continue;

      mine.push(task);
      // 和新进来的消息走同一条队列：捡回来的任务不能和它们撞在一起
      void this.deliver(job, task.threadId, null).catch((err: unknown) => {
        console.error(`[recover] ${task.id} ${task.stage}`, err);
      });
    }
    return mine;
  }

  /**
   * 拿着锁把队列清空，清完放开。
   *
   * 每条都重新 load 一遍：排队可能排了很久，任务早就不是入队时那个样子了。谁来接
   * 这条按此刻的阶段算——入队时归话题助手的，取出来时可能已经该产品接手了。
   */
  private async drain(lease: Lease, threadId: string): Promise<void> {
    try {
      while (true) {
        const event = await popPending(threadId);
        if (event === null) break;

        try {
          const task = await this.sessionStore.load(threadId);
          if (!task) continue;
          // 翻上去点了一张旧卡片
          if (event.stage && task.stage !== event.stage) continue;

          await this.step(task, event.msg && !event.msg.fromBot ? event.msg : null);
        } catch (err) {
          // 一条崩了不能把这个话题堵死，剩下的接着跑
          console.error(`[drain] ${threadId}`, err);
        }
      }
    } finally {
      await lease.release();
    }

    // 放开锁到别人 push 之间有个窗口，落在那儿的那条谁都没接住。回头看一眼，
    // 有就再抢一次接着清——不然它要等到下一条消息进来才会被顺带处理掉。
    if ((await pendingCount(threadId)) > 0) {
      const again = await acquireThread(threadId);
      if (again) await this.drain(again, threadId);
    }
  }

  /** 冲着用户刚说的那句回，让他看得出是哪句被记下了 */
  private async hintBusy(task: Session, msg: Inbound): Promise<void> {
    const node = this.workflow.at(task.stage);
    if (!node.agent) return;

    if (!(await claim(`hint:${task.threadId}`, 10))) return;

    try {
      await node.agent.reply(
        msg.messageId,
        generateCard({
          tone: "progress",
          title: "排队中",
          body: `正在${node.label}，你说的我记下了，这一轮跑完就处理。`,
        }),
      );
    } catch (err) {
      console.error(`[hint] ${task.id}`, err);
    }
  }

  /** 跑一棒。跑完要么停在原地等人说话，要么落盘 + @ 下一棒，然后就返回。 */
  private async step(task: Session, message: Inbound | null): Promise<Session> {
    const node = this.workflow.at(task.stage);
    // 终点：没人认领，也就没人再推了
    if (!node.agent) {
      return task.phase === "waiting"
        ? task
        : this.sessionStore.save({ ...task, phase: "waiting" });
    }

    const input = this.inputFor(task);
    const control = new AbortController();
    this.inflight.set(task.threadId, control);
    let current = await this.sessionStore.save({ ...task, phase: "running" });

    let result: StepResult;
    try {
      // stage 和 input 的对应关系 inputFor 刚验过，但那是运行期的事，类型上
      // 接不上——只此一处硬转
      result = await node.agent.run({
        stage: node.stage,
        task: current,
        input,
        message,
        signal: control.signal,
      } as StepContext);
    } catch (err) {
      // 中断也好、跑挂了也好，这一棒都退回没开工：下次启动从这一棒重新开始，
      // 不会停在半路无人认领。
      await this.sessionStore.save({ ...current, phase: "pending" });
      throw err;
    } finally {
      this.inflight.delete(task.threadId);
    }

    if (result.patch) {
      const { title, request, plan, reviewNote, acceptNote, settled, repo, turns } =
        result.patch;
      current = {
        ...current,
        ...(title !== undefined && { title }),
        ...(request !== undefined && { request }),
        ...(plan !== undefined && { plan }),
        ...(reviewNote !== undefined && { reviewNote }),
        ...(acceptNote !== undefined && { acceptNote }),
        ...(settled !== undefined && { settled }),
        ...(repo !== undefined && { repo }),
        // 一棒交上来的是自己那一段，按它当前所在的阶段归位——写不到别人头上
        ...(turns && { turns: { ...current.turns, [current.stage]: turns } }),
      };
    }

    // 这一棒说等人说话，就停在这儿
    if (result.kind === "wait") {
      return this.sessionStore.save({ ...current, phase: "waiting" });
    }

    // 往前走还是打回上一棒都走这里，图上没有那条边就炸
    const to = this.workflow.advance(current.stage, result.to);
    const next = await this.sessionStore.save({
      ...current,
      stage: to,
      // 打回去的那一棒也是从头开始，所以一律 pending
      phase: "pending",
      // 记在目标阶段名下——它是「进 to 这一棒时手里的单子」，不是「离开 from 时的」
      stageRecord: {
        ...current.stageRecord,
        [to]: { from: current.stage, output: result.output },
      },
    });

    // 先落盘再 @：@ 发失败了任务停在 pending，下次启动 recover 还能捡回来；
    // 反过来先 @ 再落盘的话，下一棒可能拿着上一版的交接单就开工了。
    await this.notify(next, node.agent);
    return next;
  }

  private async notify(task: Session, from: Agent): Promise<void> {
    const node = this.workflow.at(task.stage);
    const to = node.agent;
    if (!to) return;

    // 拿不到 open_id 就退而求其次写个名字，至少群里看得见交给谁了
    const at = to.openId ? `<at user_id="${to.openId}"></at>` : `@${to.job}`;
    try {
      await from.botSay(task, `${at} ${task.id} 轮到你了：${node.label}`);
    } catch (err) {
      console.error(`[notify] ${task.id} → ${task.stage}`, err);
    }
  }

  /**
   * 取这一棒开工要用的那张单子，按它声明的形状验一遍。
   *
   * 单子是落过盘的，可能是上个版本的代码写的；上一棒也可能干脆没给。两种都得在
   * 开工前拦下来——让它揣着半张单子跑起来，错会飘到很后面才显形。
   */
  private inputFor(task: Session): unknown {
    const record = task.stageRecord[task.stage];
    const parsed = WorkflowStageSchema[task.stage].safeParse(record?.output);
    if (parsed.success) return parsed.data;
    throw new Error(
      `任务 ${task.id} 进 ${task.stage} 时交接单对不上（来自 ${record?.from ?? "入口"}）：\n` +
        parsed.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
}
