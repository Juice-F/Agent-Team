import { feishu } from "../config.js";
import type { Runner } from "../workflow/runner.js";
import type { Session } from "../store/index.js";
import type {
  Agent,
  AgentJob,
  Inbound,
  StepContext,
  StepResult,
  WorkflowStage,
} from "../types.js";
import { generateCard } from "../feishu/card.js";
import { FeishuChannel } from "../feishu/index.js";

export abstract class BaseAgent implements Agent {
  protected readonly bot: FeishuChannel;
  protected runner!: Runner;

  constructor(
    readonly job: AgentJob,
    readonly handles: readonly WorkflowStage[],
  ) {
    this.bot = new FeishuChannel(job, feishu[job]);
  }

  get openId(): string {
    if (!this.bot.openId) {
      throw new Error(`「${this.job}」open_id 还没就绪，start() 之后才能用`);
    }
    return this.bot.openId;
  }

  async say(task: Session, text: string): Promise<void> {
    await this.bot.replyText(task.rootMessageId, text, { inThread: true });
  }

  async start(runner: Runner): Promise<void> {
    this.runner = runner;
    await this.bot.start({
      onThread: (threadId, msg) => runner.deliver(this.job, threadId, msg),
      onGroup: (msg) => this.onGroup(msg),
      onCardAction: (action) => runner.click(this.job, action),
    });
    await this.bot.resolveOpenId();
  }

  abstract run(ctx: StepContext): Promise<StepResult>;

  protected abstract onGroup(msg: Inbound): Promise<void>;

  /**
   * 占位不写成空实现——任务是真的会停在这个阶段的，群里得看得见它停在哪，否则
   * 一个需求立完项就没声了，谁也分不清是卡住了还是压根没跑起来。
   */
  protected async pending(
    ctx: StepContext,
    what: string,
  ): Promise<StepResult> {
    // 上一棒刚交过来的时候报个到就行；停在这之后话题里的讨论先不接
    if (ctx.message) return { kind: "wait" };

    await this.bot.replyCard(
      ctx.task.rootMessageId,
      generateCard({
        tone: "info",
        title: `${what}：还没接入`,
        subtitle: ctx.task.id,
        body: `任务停在 **${ctx.stage}**，这个角色实现之后会从这里接着走。`,
      }),
      { inThread: true },
    );
    return { kind: "wait" };
  }
}
