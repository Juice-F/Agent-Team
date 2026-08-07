import type { AgentJob, WorkflowStage } from "../type.js";
import type { Inbound } from "../feishu/index.js";
import { enqueue } from "../store/queue.js";
import type { Task } from "../store/task.js";
import type { Node, Workflow } from "./graph.js";
import { WorkflowStageSchema } from "../schema.js";
import type { Engine, StepContext, StepResult } from "./types.js";

/**
 * 按图把任务一棒棒推下去。
 *
 * 一条消息进来 → 交给当前阶段的认领人 → 它交棒 → 引擎验边、落盘、把产出塞给
 * 下一棒 → 直到某一棒说「等人说话」或者走到终点。
 *
 * 每一棒开工前和交棒后都落盘，任务文件永远说得清它此刻在哪、是在跑还是在等。
 * 被打断（进程退出、外面喊停、这一棒自己抛了）就退回「没开工」，下一条消息或者
 * 下次启动重跑那一棒——中断恢复靠的是这个，不是内存里的什么东西。
 */

export interface TaskStore {
  load(threadId: string): Promise<Task | null>;
  save(task: Task): Promise<void>;
  /** 启动恢复要用：把盘上所有任务翻一遍，挑出中断在半路的 */
  list(): Promise<Task[]>;
}

/** 被 interrupt() 打断，不是自己跑挂的 */
export class Interrupted extends Error {}

/**
 * 一次消息最多连推几棒。
 *
 * 审查↔研发、验收↔研发都是环，某一棒逻辑写错就会原地打转。跑到头直接抛，
 * 比让它把模型额度烧光强。人手推进的流程连着跑五六棒已经很多了。
 */
const MAX_HOPS = 12;

export class Runner implements Engine {
  /** 正在跑的那些棒，按话题存，用来打断 */
  private readonly inflight = new Map<string, AbortController>();

  constructor(
    private readonly graph: Workflow,
    private readonly store: TaskStore,
  ) {}

  /** 把所有角色的服务拉起来，再把中断在半路的任务捡回来 */
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
    await this.drive(task, msg);
  }

  /** 新立的单子，或者要把一个停着的任务踢一脚 */
  async resume(task: Task): Promise<void> {
    await this.drive(task, null);
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
   * 进程没了，要么交接完还没开工。它们在后台各自往下走，不挡启动。
   */
  private async recover(): Promise<Task[]> {
    const stuck = (await this.store.list()).filter(
      (task) => task.phase !== "waiting" && this.graph.ownerOf(task.stage),
    );
    for (const task of stuck) {
      // 走同一条按话题串行的队列：捡回来的任务和新进来的消息不能撞在一起
      void enqueue(task.threadId, () => this.drive(task, null)).catch(
        (err: unknown) => {
          console.error(`[recover] ${task.id} ${task.stage}`, err);
        },
      );
    }
    return stuck;
  }

  private async drive(task: Task, message: Inbound | null): Promise<Task> {
    let current = task;
    let trigger = message;

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const node = this.graph.at(current.stage);
      // 终点：没人认领，也就没人再推了
      if (!node.agent) {
        return current.phase === "waiting"
          ? current
          : this.save({ ...current, phase: "waiting" });
      }

      const input = this.handoffInto(node, current);
      const control = new AbortController();
      this.inflight.set(current.threadId, control);
      current = await this.save({ ...current, phase: "running" });

      let result: StepResult;
      try {
        const ctx: StepContext<WorkflowStage> = {
          stage: node.stage,
          task: current,
          input,
          message: trigger,
          signal: control.signal,
        };
        // 引擎按运行期的 stage 分发，形状 handoffInto 刚验过，只此一处硬转
        result = await node.agent.run(ctx as never);
      } catch (err) {
        // 中断也好、跑挂了也好，这一棒都退回没开工：下一条消息或者下次启动
        // 从这一棒重新开始，不会停在半路无人认领。
        await this.save({ ...current, phase: "pending" });
        throw err;
      } finally {
        this.inflight.delete(current.threadId);
      }

      if (result.patch) current = { ...current, ...result.patch };

      // 这一棒说等人说话，就停在这儿，别往下推
      if (result.kind === "wait") {
        return this.save({ ...current, phase: "waiting" });
      }

      // 往前走还是打回上一棒都走这里，图上没有那条边就炸
      const to = this.graph.advance(current.stage, result.to);
      current = await this.save({
        ...current,
        stage: to,
        // 打回去的那一棒也是从头开始，所以一律 pending
        phase: "pending",
        handoff: { from: current.stage, output: result.output },
      });
      // 后面几棒是被推起来的，没有触发消息
      trigger = null;
    }

    throw new Error(
      `任务 ${task.id} 连推 ${MAX_HOPS} 棒还没停下来，八成是哪一棒在环里打转`,
    );
  }

  private async save(task: Task): Promise<Task> {
    await this.store.save(task);
    return task;
  }

  /**
   * 取上一棒交下来的东西，按这一棒声明的形状验一遍。
   *
   * 交接单是落过盘的，可能是上个版本的代码写的；上一棒也可能干脆没给。两种都
   * 得在开工前拦下来——让它揣着半张单子跑起来，错会飘到很后面才显形。
   */
  private handoffInto(node: Node, task: Task): never {
    const parsed = WorkflowStageSchema[node.stage].safeParse(task.handoff?.output);
    if (parsed.success) return parsed.data as never;
    throw new Error(
      `任务 ${task.id} 进 ${node.stage} 时交接单对不上（来自 ${task.handoff?.from ?? "入口"}）：\n` +
        parsed.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
}
