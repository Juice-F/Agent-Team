import { feishuConfig } from "../config.js";
import type { Runner } from "../workflow/runner.js";
import type { Session } from "../postgres/session.js";
import type {
  Agent,
  AgentJob,
  Inbound,
  StepContext,
  StepResult,
  WorkflowStage,
} from "../types.js";
import { FeishuChannel } from "../feishu/index.js";
import type { Card } from "../feishu/card.js";

export abstract class BaseAgent implements Agent {
  protected readonly bot: FeishuChannel;

  constructor(
    readonly job: AgentJob,
    readonly handles: readonly WorkflowStage[],
  ) {
    this.bot = new FeishuChannel(job, feishuConfig[job]);
  }

  get openId(): string {
    if (!this.bot.openId) {
      throw new Error(`「${this.job}」open_id 还没就绪，start() 之后才能用`);
    }
    return this.bot.openId;
  }

  async botSay(task: Session, text: string): Promise<void> {
    await this.bot.replyText(task.rootMessageId, text, { inThread: true });
  }

  async reply(messageId: string, card: Card): Promise<void> {
    await this.bot.replyCard(messageId, card, { inThread: true });
  }

  async start(runner: Runner): Promise<void> {
    await this.bot.start({
      onGroup: (msg) => this.onGroup(msg),
      onThread: (threadId, msg) => runner.deliver(this.job, threadId, msg),
      onCardAction: (action) => runner.click(this.job, action),
    });
    await this.bot.resolveOpenId();
  }

  abstract run(ctx: StepContext): Promise<StepResult>;

  protected abstract onGroup(msg: Inbound): Promise<void>;
}
