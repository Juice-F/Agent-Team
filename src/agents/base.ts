import { feishu } from "../config.js";
import type { AgentJob } from "../type.js";
import { generateCard } from "../feishu/card.js";
import { FeishuChannel, type ChannelHandler } from "../feishu/index.js";
import type { WorkflowStage } from "../type.js";
import type {
  Agent,
  Engine,
  StageContext,
  StepContext,
  StepResult,
} from "../workflow/index.js";

/**
 * 一个角色的公共部分。
 *
 * 每个角色自带一个飞书 bot（凭证按 job 从配置里取），`workflow.run()` 时统一
 * 拉起来。收到话题消息就喊一声 engine.deliver，往哪走、什么时候落盘都不归它管
 * ——不是自己认领的阶段引擎会丢掉，所以这里不用判断。
 *
 * 子类只要说清楚两件事：认领哪几棒（handles），那几棒干什么（run）。
 */
export abstract class BaseAgent<S extends WorkflowStage> implements Agent<S> {
  protected readonly bot: FeishuChannel;
  /** start() 之后才有。要主动踢流程一脚（比如刚立完项）的角色用得上。 */
  protected engine!: Engine;

  constructor(
    readonly job: AgentJob,
    readonly handles: readonly S[],
  ) {
    this.bot = new FeishuChannel(job, feishu[job]);
  }

  async start(engine: Engine): Promise<void> {
    this.engine = engine;
    await this.bot.start(this.channel(engine));
  }

  abstract run(ctx: StageContext<S>): Promise<StepResult>;

  /** 默认只收话题里的消息。还要收主群 @ 的角色自己覆写。 */
  protected channel(engine: Engine): ChannelHandler {
    return {
      onThread: (threadId, msg) => engine.deliver(this.job, threadId, msg),
    };
  }

  /**
   * 这一棒还没实现：接住任务，在群里说清楚它停在哪，然后等着。
   *
   * 占位不写成空实现——任务是真的会停在这个阶段的，群里得看得见它停在哪，否则
   * 一个需求立完项就没声了，谁也分不清是卡住了还是压根没跑起来。
   */
  protected async pending(
    ctx: StepContext<WorkflowStage>,
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
