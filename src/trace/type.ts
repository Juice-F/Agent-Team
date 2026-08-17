/**
 * 这次调用是替谁跑的。
 *
 * 没有它，model 层记下来的每一次都是孤立的——你能看到「有人花了 18 分钟」，
 * 但不知道是哪个任务的哪一棒。多实例下更糟：同一个任务的 spec 在 A 机、coding
 * 在 B 机是常态，没有 taskId 根本拼不出一条链。
 */
export interface TraceContext {
  /** 流程里的任务用 Session.id；立项之前没有任务，用 `inbox:<飞书消息 id>` */
  readonly taskId: string;
  /** WorkflowStage，或者立项之前的 "inbox" */
  readonly stage: string;
  /** AgentJob，或者路由里的 classifier / responder / judge */
  readonly job: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** 参数，已截断。没有它就只知道「调了 9 次 Edit」，答不上改了哪 9 个文件 */
  input: string;
  /** 结果，已截断。undefined = 没等到结果（被中断、超时、或者 CLI 挂了） */
  output?: string;
  ok?: boolean;
  /** 发起到拿到结果的毫秒数。undefined 同上 */
  ms?: number;
  /** 相对这次调用开跑的偏移，用来画时间线 */
  readonly atMs: number;
}

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
  readonly turns: number;
}

/**
 * 一次模型调用的汇总。
 *
 * 现在它跟着完整现场一起落进对象存储；等 PG 那半接上，这个形状会原样变成
 * 表里的一行——所以字段都是标量，没有嵌套结构。
 */
export interface CallSpan {
  readonly callId: string;
  readonly instanceId: string;
  readonly taskId: string;
  readonly stage: string;
  readonly job: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly repoPath: string | null;
  /** null = 纯生成，没碰仓库 */
  readonly repoWrite: boolean | null;
  readonly startedAt: string;
  /**
   * 等闸门的毫秒数。
   *
   * 一定要和 runMs 分开：卡片半天不动的时候，「在排队」和「模型真在跑」要做的事
   * 完全不同，混成一个总耗时就分不出来了。
   */
  readonly queuedMs: number;
  readonly runMs: number;
  readonly ok: boolean;
  readonly error: string | null;
  readonly usage: Usage | null;
  readonly toolCount: number;
  /** 工具名 → 次数。一眼看出这一棒在干嘛，不用去翻原始流 */
  readonly toolHistogram: Record<string, number>;
  /** 完整现场在对象存储里的 key */
  readonly rawKey: string;
  /** 原始 stdout 的字符数（截断前）。落盘大小心里有个数 */
  readonly rawBytes: number;
}

/** 落进对象存储的那个对象，解压之后就是这个形状 */
export interface RawTrace {
  readonly span: CallSpan;
  readonly tools: ToolCall[];
  /** CLI 原始 stdout，可能被首尾截断过 */
  readonly stdout: string;
  readonly stderrTail: string;
  readonly truncated: boolean;
}

/** CLI 吐的事件流是什么格式，决定用哪个 parser。none = 不解析 */
export type StreamFormat = "claude-stream-json" | "none";

/** 开一条记录需要知道的东西。ctx 为空就是不记，见 tracer.begin */
export interface SpanSeed {
  readonly ctx: TraceContext | undefined;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly repo: { path: string; write: boolean } | null;
  readonly format: StreamFormat;
}
