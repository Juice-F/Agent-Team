import type { Agent, AgentJob, Inbound, StepContext, StepResult } from "../types.js";
import type { CardAction } from "../feishu/index.js";
import { CardChoiceSchema, WorkflowStageSchema } from "../schema.js";
import { enqueue } from "../utils/queue.js";
import type { Session, SessionStore } from "../store/index.js";
import type { Workflow } from "./graph.js";

/** 被 interrupt() 打断，不是自己跑挂的 */
export class Interrupted extends Error {}

export class Runner {
  private readonly inflight = new Map<string, AbortController>();
  private readonly clicking = new Set<string>();

  constructor(
    private readonly graph: Workflow,
    private readonly store: SessionStore,
  ) {}

  async start(): Promise<Session[]> {
    await Promise.all(this.graph.agents.map((agent) => agent.start(this)));
    return this.recover();
  }

  // 话题里接收消息
  async deliver(job: AgentJob, threadId: string, msg: Inbound): Promise<void> {
    const task = await this.store.load(threadId);
    if (!task) return;
    if (this.graph.ownerOf(task.stage) !== job) return;
    
    await this.step(task, msg.fromBot ? null : msg);
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

    // 占位得在第一个 await 之前，而且要同步占。连点两下是两次并发回调，等 load
    // 回来再判的话，两边看到的都是「没人在跑」，一样会跑出两遍。
    if (this.clicking.has(choice.threadId)) return "上一次还在处理，等一下";
    this.clicking.add(choice.threadId);

    let queued = false;
    try {
      const task = await this.store.load(choice.threadId);
      if (!task) return "找不到这个任务";
      if (this.graph.ownerOf(task.stage) !== job) return "这一步已经不归我管了";
      if (task.stage !== choice.stage) {
        return `任务已经走到「${this.graph.at(task.stage).label}」，这张卡片过期了`;
      }

      const message: Inbound = {
        text: choice.text,
        messageId: action.messageId,
        chatId: action.chatId,
        fromBot: false,
        confirmed: choice.confirm,
      };
      const done = enqueue(choice.threadId, async () => {
        // 排到队头时盘上那份才作数——排队期间话题里可能已经聊过好几轮了
        const fresh = await this.store.load(choice.threadId);
        if (!fresh || fresh.stage !== choice.stage) return;
        await this.step(fresh, message);
      });
      queued = true;

      void done
        .catch((err: unknown) => {
          console.error(`[click] ${task.id} ${task.stage}`, err);
        })
        // 那一棒真跑完了才放开，不是排上队就放开
        .finally(() => this.clicking.delete(choice.threadId));

      return "收到";
    } finally {
      // 没排上队就当场放开，否则这个话题的按钮以后再也点不动了
      if (!queued) this.clicking.delete(choice.threadId);
    }
  }

  async resume(task: Session, from: Agent): Promise<void> {
    await this.notify(task, from);
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

  private async recover(): Promise<Session[]> {
    const stuck = (await this.store.list()).filter(
      (task) => task.phase !== "waiting" && this.graph.ownerOf(task.stage),
    );
    for (const task of stuck) {
      // 走同一条按话题串行的队列：捡回来的任务和新进来的消息不能撞在一起
      void enqueue(task.threadId, () => this.step(task, null)).catch(
        (err: unknown) => {
          console.error(`[recover] ${task.id} ${task.stage}`, err);
        },
      );
    }
    return stuck;
  }

  /** 跑一棒。跑完要么停在原地等人说话，要么落盘 + @ 下一棒，然后就返回。 */
  private async step(task: Session, message: Inbound | null): Promise<Session> {
    const node = this.graph.at(task.stage);
    // 终点：没人认领，也就没人再推了
    if (!node.agent) {
      return task.phase === "waiting"
        ? task
        : this.store.save({ ...task, phase: "waiting" });
    }

    const input = this.inputFor(task);
    const control = new AbortController();
    this.inflight.set(task.threadId, control);
    let current = await this.store.save({ ...task, phase: "running" });

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
      await this.store.save({ ...current, phase: "pending" });
      throw err;
    } finally {
      this.inflight.delete(task.threadId);
    }

    if (result.patch) {
      const { title, request, plan, reviewNote, acceptNote, turns } =
        result.patch;
      current = {
        ...current,
        ...(title !== undefined && { title }),
        ...(request !== undefined && { request }),
        ...(plan !== undefined && { plan }),
        ...(reviewNote !== undefined && { reviewNote }),
        ...(acceptNote !== undefined && { acceptNote }),
        // 一棒交上来的是自己那一段，按它当前所在的阶段归位——写不到别人头上
        ...(turns && { turns: { ...current.turns, [current.stage]: turns } }),
      };
    }

    // 这一棒说等人说话，就停在这儿
    if (result.kind === "wait") {
      return this.store.save({ ...current, phase: "waiting" });
    }

    // 往前走还是打回上一棒都走这里，图上没有那条边就炸
    const to = this.graph.advance(current.stage, result.to);
    const next = await this.store.save({
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
    const node = this.graph.at(task.stage);
    const to = node.agent;
    if (!to) return;

    // 拿不到 open_id 就退而求其次写个名字，至少群里看得见交给谁了
    const at = to.openId ? `<at user_id="${to.openId}"></at>` : `@${to.job}`;
    try {
      await from.say(task, `${at} ${task.id} 轮到你了：${node.label}`);
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
