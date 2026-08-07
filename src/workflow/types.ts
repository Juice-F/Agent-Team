import type { z } from "zod";
import type { AgentJob, WorkflowStage } from "../type.js";
import type { Inbound } from "../feishu/index.js";
import type { Task } from "../store/task.js";
import type { WorkflowStageSchema } from "../schema.js";

/**
 * agent 和流程之间的契约。
 *
 * 这个文件只有类型，没有一行运行时代码——各 agent import 它来写自己那一棒，
 * `import type` 编译后整句消失，所以 agents 和 workflow 之间不会绕出循环依赖。
 */

/**
 * 阶段名 → 那一棒手里那张交接单的形状。
 *
 * 从 WorkflowStageSchema 推出来，所以 schema.ts 那张表改了，各棒的收货/交货类型跟着变，
 * 不用在两个地方各写一遍。
 */
export type Payloads = {
  [K in WorkflowStage]: z.infer<(typeof WorkflowStageSchema)[K]>;
};

/** 一棒能改的任务字段。stage 不在里面：走到哪由引擎按图推，不许自己写。 */
export type TaskPatch = Partial<Pick<Task, "title" | "request" | "turns">>;

/**
 * 轮到你了，这是现场。
 *
 * `stage` 是判别字段：一个 agent 认领了好几棒时，`switch (ctx.stage)` 就能把
 * `input` 收窄到那一棒真正收到的形状。
 */
export interface StepContext<K extends WorkflowStage> {
  readonly stage: K;
  /** 当前任务的快照，stage 就是这一棒自己 */
  readonly task: Task;
  /** 上一棒交下来的东西，已按本阶段声明的 schema 校验过 */
  readonly input: Payloads[K];
  /**
   * 触发这一轮的用户消息。被上一棒直接推起来的没有（null）——需要人开口才能
   * 往下走的阶段（澄清、验收），见到 null 就该原地等着。
   */
  readonly message: Inbound | null;
  /**
   * 中断信号。
   *
   * 一棒可能跑十几分钟，中途进程要退、或者外面要求停下，就从这里通知。模型调用
   * 一路把它带下去，abort 之后 CLI 子进程会被杀掉；自己写循环的话记得看一眼。
   * 被打断的那一棒会退回「没开工」，下次消息或者下次启动重跑。
   */
  readonly signal: AbortSignal;
}

/** 认领了 S 这几棒的 agent，run() 收到的就是这几棒的联合 */
export type StageContext<S extends WorkflowStage> = { [K in S]: StepContext<K> }[S];

/**
 * 交棒：说清楚交给谁、带什么过去。
 *
 * 往前走还是打回上一棒，由业务逻辑自己定——只要图上有那条边。写成按 to 分发的
 * 联合类型，`to` 一填死，`output` 就只能是那个阶段声明的形状，少个字段编译期
 * 就红。
 */
export type Handoff = {
  [K in WorkflowStage]: {
    readonly kind: "next";
    readonly to: K;
    readonly output: Payloads[K];
    readonly patch?: TaskPatch;
  };
}[WorkflowStage];

/** 停在原地，等下一条消息把这一棒再叫醒 */
export interface Wait {
  readonly kind: "wait";
  readonly patch?: TaskPatch;
}

export type StepResult = Handoff | Wait;

/**
 * 流程给 agent 的把手。
 *
 * agent 只管收消息和干活，往哪走、什么时候落盘、谁认领这一棒，都不归它管——
 * 收到消息喊一声 deliver，剩下的引擎自己推。
 */
export interface Engine {
  /** 话题里来消息了。不是你认领的阶段，引擎会自己丢掉。 */
  deliver(job: AgentJob, threadId: string, msg: Inbound): Promise<void>;
  /** 新立的单子、或者要把一个停着的任务踢一脚 */
  resume(task: Task): Promise<void>;
  /** 打断这个话题上正在跑的那一棒。没在跑就返回 false。 */
  interrupt(threadId: string, reason?: string): boolean;
}

/**
 * 一个角色。
 *
 * 泛型 S 是它认领哪几棒。图上接线时对不上就红——把 coding 派给只会拆需求的
 * 产品经理，编译期就过不去。
 */
export interface Agent<S extends WorkflowStage = WorkflowStage> {
  readonly job: AgentJob;
  /** 认领哪几棒。类型和运行时都靠它对账。 */
  readonly handles: readonly S[];
  /** 启动自己的服务（连飞书、挂事件）。`workflow.run()` 时统一拉起来。 */
  start(engine: Engine): Promise<void>;
  /** 轮到自己那一棒时干的活。一个 agent 管几棒就 switch ctx.stage。 */
  run(ctx: StageContext<S>): Promise<StepResult>;
}

/**
 * 擦掉「认领哪几棒」的 agent。
 *
 * 图和引擎存的是这个：它们按运行期的 stage 分发，具体形状在接线那一刻已经
 * 对过账了。`run` 收 never 是故意的——只有引擎能调，agent 之间调不动彼此。
 */
export interface AnyAgent {
  readonly job: AgentJob;
  readonly handles: readonly WorkflowStage[];
  start(engine: Engine): Promise<void>;
  run(ctx: never): Promise<StepResult>;
}
