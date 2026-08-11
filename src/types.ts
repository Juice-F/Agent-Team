import type { z } from "zod";
import type { WorkflowStageSchema } from "./schema.js";
import type { Session, Turn } from "./session/index.js";
import type { Runner } from "./workflow/runner.js";

export type Provider = "claude" | "codex";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export interface AgentSpec {
  provider: Provider;
  model: string;
  effort: Effort;
  timeoutMs: number;
}

export interface Inbound {
  text: string;
  messageId: string;
  chatId: string;
  /**
   * 发消息的是不是机器人。
   *
   * 交棒是「上一棒的 bot 在话题里 @ 下一棒的 bot」，所以这条消息不是人在说话，
   * 而是「轮到你了」的信号——那一棒该当成被推起来的（ctx.message 为 null）。
   */
  fromBot: boolean;
  /**
   * 这条不是打字打出来的，是用户点了卡片上的「确认」类按钮。
   *
   * 点确认认可的是他眼前那张卡片上的内容，所以见到它就直接往下走，别再问一遍
   * 模型——重问一遍拿回来的可能已经不是用户看过的那一版了。
   */
  confirmed?: boolean;
  /**
   * 点按钮时一并带回来的东西：按钮 value 里挂的参数，加上卡片上表单填的值。
   *
   * 打字进来的消息没有这个。挂在消息上而不是另开一条路，是因为点按钮本来就当成
   * 「用户在话题里说了这句话」在走，带回来的参数是那句话的一部分。
   */
  data?: Record<string, string>;
}
export type AgentJob = "triage" | "product" | "dev" | "review";
export type WorkflowStage =
  | "clarifying"
  | "spec"
  | "coding"
  | "review"
  | "accepting"
  | "done";

/** 阶段名 → 那一棒手里那张交接单的形状。schema.ts 改了这里跟着变。 */
type Payloads = {
  [K in WorkflowStage]: z.infer<(typeof WorkflowStageSchema)[K]>;
};

/** 一棒能改的任务字段。stage 不在里面：走到哪由引擎按图推，不许自己写。 */
export type TaskPatch = Partial<
  Pick<
    Session,
    | "title"
    | "request"
    | "plan"
    | "reviewNote"
    | "acceptNote"
    | "settled"
    | "repo"
  >
> & {
  /**
   * 自己这一棒和用户的往返，整段覆盖。
   *
   * 写的时候不用管是哪个阶段——引擎按当前阶段并进 task.turns，所以一棒只可能
   * 改到自己那一段，写不到别人头上。
   */
  readonly turns?: Turn[];
};

/**
 * 轮到你了，这是现场。
 *
 * 写成按 stage 分发的联合：`switch (ctx.stage)` 一收窄，`input` 就是那一棒真正
 * 收到的形状，不会串。管一棒的角色先把不是自己的挡掉，剩下的同样是收窄。
 */
export type StepContext = {
  [K in WorkflowStage]: {
    readonly stage: K;
    /** 当前任务的快照，stage 就是这一棒自己 */
    readonly task: Session;
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
     * 一棒可能跑十几分钟，中途进程要退、或者外面要求停下，就从这里通知。模型
     * 调用一路把它带下去，abort 之后 CLI 子进程会被杀掉；自己写循环的话记得
     * 看一眼。被打断的那一棒会退回「没开工」，下次消息或者下次启动重跑。
     */
    readonly signal: AbortSignal;
  };
}[WorkflowStage];


export type Next = {
  [K in WorkflowStage]: {
    readonly kind: "next";
    readonly to: K;
    readonly output: Payloads[K];
    readonly patch?: TaskPatch;
  };
}[WorkflowStage];

export interface Wait {
  readonly kind: "wait";
  readonly patch?: TaskPatch;
}

export type StepResult = Next | Wait;

export interface Agent {
  readonly job: AgentJob;
  readonly handles: readonly WorkflowStage[];
  readonly openId: string;
  start(runner: Runner): Promise<void>;
  run(ctx: StepContext): Promise<StepResult>;
  say(task: Session, text: string): Promise<void>;
}
