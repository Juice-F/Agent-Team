import type { Agent, AgentJob, Inbound, StepContext, StepResult } from "../types.js";
import { WorkflowStageSchema } from "../schema.js";
import { enqueue } from "../utils/queue.js";
import type { Task, TaskStore } from "../store/index.js";
import type { Workflow } from "./graph.js";

/**
 * 按图把任务一棒棒推下去。
 *
 * 一次只跑一棒：跑完落盘，然后在话题里 @ 下一棒的认领人，就返回了。下一棒是被
 * 那条 @ 消息叫醒的，不是这里接着调用的——四个角色各有各的 bot，交棒得走群里，
 * 群里也得看得见接力棒传给了谁。
 *
 * 这么写还顺带解决两件事：一条用户消息不会把整条链（可能几十分钟）卡在一个飞书
 * 事件回调里；按话题串行的队列每棒之间会松开，用户中途插话不用排队等到底。
 *
 * 每一棒开工前和交棒后都落盘，任务文件永远说得清它此刻在哪、是在跑还是在等。
 * 被打断（进程退出、外面喊停、这一棒自己抛了）就退回「没开工」，下次启动
 * recover 从那一棒重来。
 */

/** 被 interrupt() 打断，不是自己跑挂的 */
export class Interrupted extends Error {}

export class Runner {
  /** 正在跑的那些棒，按话题存，用来打断 */
  private readonly inflight = new Map<string, AbortController>();

  constructor(
    private readonly graph: Workflow,
    private readonly store: TaskStore,
  ) {}

  async start(): Promise<Task[]> {
    await Promise.all(this.graph.agents.map((agent) => agent.start(this)));
    return this.recover();
  }

  /**
   * 话题里来消息了。
   *
   * 四个角色都在群里，同一条话题消息四个人都收得到，所以这里要认领判断——
   * 不是你这一棒的，直接丢。
   */
  async deliver(job: AgentJob, threadId: string, msg: Inbound): Promise<void> {
    const task = await this.store.load(threadId);
    if (!task) return;
    if (this.graph.ownerOf(task.stage) !== job) return;
    // 机器人 @ 过来的是交棒信号，不是人在说话——那一棒该当成「被推起来的」
    await this.step(task, msg.fromBot ? null : msg);
  }

  /**
   * 把一个刚建好的任务交出去：在话题里 @ 当前阶段的认领人。
   *
   * `from` 是发这条 @ 的角色。立项那次由话题助手发——它判断完才有单子，而这一步
   * 不属于流程里的任何一棒，所以得由调用方说清楚是谁在交。
   */
  async resume(task: Task, from: Agent): Promise<void> {
    await this.notify(task, from);
  }

  /** 打断这个话题上正在跑的那一棒 */
  interrupt(threadId: string, reason = "外部中断"): boolean {
    const control = this.inflight.get(threadId);
    if (!control) return false;
    control.abort(new Interrupted(reason));
    return true;
  }

  /** 全打断，退出前用。返回打断了几个。 */
  interruptAll(reason = "进程退出"): number {
    const threads = [...this.inflight.keys()];
    for (const threadId of threads) this.interrupt(threadId, reason);
    return threads.length;
  }

  /**
   * 把中断在半路的任务捡回来接着跑。
   *
   * 盘上的 phase 不是 waiting、阶段又有人认领的，就是上次没跑完的：要么正跑着
   * 进程没了，要么交棒的 @ 还没发出去人就没了。这里直接把那一棒跑起来，不再等
   * 消息——重启这种场景没人会替它补一条 @。
   */
  private async recover(): Promise<Task[]> {
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
  private async step(task: Task, message: Inbound | null): Promise<Task> {
    const node = this.graph.at(task.stage);
    // 终点：没人认领，也就没人再推了
    if (!node.agent) {
      return task.phase === "waiting"
        ? task
        : this.store.save({ ...task, phase: "waiting" });
    }

    const input = this.handoffInto(task);
    const control = new AbortController();
    this.inflight.set(task.threadId, control);
    let current = await this.store.save({ ...task, phase: "running" });

    let result: StepResult;
    try {
      // stage 和 input 的对应关系 handoffInto 刚验过，但那是运行期的事，类型上
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

    if (result.patch) current = { ...current, ...result.patch };

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
      handoff: { from: current.stage, output: result.output },
    });

    // 先落盘再 @：@ 发失败了任务停在 pending，下次启动 recover 还能捡回来；
    // 反过来先 @ 再落盘的话，下一棒可能拿着上一版的交接单就开工了。
    await this.notify(next, node.agent);
    return next;
  }

  /**
   * 在话题里 @ 一下这一棒的认领人，把它叫醒。
   *
   * 发不出去不抛——这一棒的活已经干完落盘了，为一条通知把它判成失败不合适。
   * 任务会停在 pending，下次启动 recover 接着走。
   */
  private async notify(task: Task, from: Agent): Promise<void> {
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
   * 取上一棒交下来的东西，按这一棒声明的形状验一遍。
   *
   * 交接单是落过盘的，可能是上个版本的代码写的；上一棒也可能干脆没给。两种都
   * 得在开工前拦下来——让它揣着半张单子跑起来，错会飘到很后面才显形。
   */
  private handoffInto(task: Task): unknown {
    const parsed = WorkflowStageSchema[task.stage].safeParse(
      task.handoff?.output,
    );
    if (parsed.success) return parsed.data;
    throw new Error(
      `任务 ${task.id} 进 ${task.stage} 时交接单对不上（来自 ${task.handoff?.from ?? "入口"}）：\n` +
        parsed.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
}
