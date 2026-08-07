import { config } from "../../config.js";
import { modelFor, type OnProgress } from "../../model/index.js";
import type { Inbound, StepContext, StepResult } from "../../types.js";
import { BaseAgent } from "../base.js";
import * as cards from "./cards.js";
import { SYSTEM } from "./prompt.js";
import { ReviewOutputSchema, type ReviewOutput } from "./schema.js";

/**
 * 代码审查。拿研发交上来的那轮改动看一遍：过了交给产品验收，没过打回 coding，
 * 打回时把意见塞进 note 一起带回去。
 *
 * 往前还是往回，是这一棒自己决定的——图上两条边都在，走哪条看审查结论。
 *
 * 但「往回」多一道人工确认：dev → review 是条环路，让它自己转起来，一个判错的
 * reject 就能拉着两个模型一直烧下去，中间没人看得见。所以判了 reject 之后这一棒
 * 停下等人点按钮，点了才真的交回研发。
 *
 * 跟研发一样开着工具跑，但只读——它得自己去看 git diff，不能动手改。
 */
export class ReviewAgent extends BaseAgent {
  constructor() {
    super("review", ["review"]);
  }

  async run(ctx: StepContext): Promise<StepResult> {
    // 引擎只拿 handles 里的阶段来叫，这句挡的是类型
    if (ctx.stage !== "review") return { kind: "wait" };
    return this.review(ctx);
  }

  protected async onGroup(_msg: Inbound): Promise<void> {}

  private async review(ctx: ReviewContext): Promise<StepResult> {
    // 点了「打回返工」：意见已经落盘，直接交回研发，不再审一遍
    if (ctx.message?.confirmed && ctx.task.reviewNote) {
      await this.bot.replyCard(
        ctx.task.rootMessageId,
        cards.sentBack(ctx.task),
        { inThread: true },
      );
      return {
        kind: "next",
        to: "coding",
        // 方案不动——代码的问题，返工改的是实现，不是需求
        output: { plan: ctx.task.plan, note: ctx.task.reviewNote },
        // 用掉就清，否则下一轮审查通过了它还挂在那儿
        patch: { reviewNote: "" },
      };
    }

    const posted = await this.bot.replyCard(
      ctx.task.rootMessageId,
      cards.reviewing(),
      { inThread: true },
    );
    const progress = this.bot.trackProgress(posted.messageId, cards.reviewing);

    let result: ReviewOutput;
    try {
      result = await this.judge(ctx, progress.on);
    } catch (err) {
      await this.bot.patchCard(posted.messageId, cards.failed());
      throw err;
    } finally {
      progress.stop();
    }

    if (result.verdict === "pass") {
      await this.bot.patchCard(posted.messageId, cards.passed(ctx.task, result));
      return {
        kind: "next",
        to: "accepting",
        output: {
          summary: `${ctx.input.summary}\n\n代码审查：${result.summary}`,
          changed: ctx.input.changed,
        },
      };
    }

    // 没过就停下等人点按钮，意见先落盘
    await this.bot.patchCard(posted.messageId, cards.rejected(ctx.task, result));
    return { kind: "wait", patch: { reviewNote: this.noteOf(result) } };
  }

  private judge(
    ctx: ReviewContext,
    onProgress: OnProgress,
  ): Promise<ReviewOutput> {
    const parts = [
      `需求：${ctx.task.title}`,
      `产品定下来的方案：\n${ctx.task.plan}`,
      `研发说这轮改了：\n${ctx.input.summary}`,
    ];
    if (ctx.input.changed.length) {
      parts.push(
        `研发列出来动过的文件：\n${ctx.input.changed.map((f) => `- ${f}`).join("\n")}\n\n这只是它自己报的，以 git diff 为准。`,
      );
    }

    return modelFor("review").generate({
      system: SYSTEM,
      user: parts.join("\n\n"),
      schema: ReviewOutputSchema,
      // 要看代码，但不许动——判改动的人不该能改它判的东西
      repo: { path: config.targetRepo, write: false },
      onProgress,
      signal: ctx.signal,
    });
  }

  /** 打回意见。研发那边直接当 note 收，所以要能独立看懂。 */
  private noteOf(result: ReviewOutput): string {
    const list = result.issues
      .map((i) => (i.file ? `- ${i.file}：${i.detail}` : `- ${i.detail}`))
      .join("\n");
    return `${result.summary}\n\n必须改掉的：\n${list}`;
  }
}

type ReviewContext = Extract<StepContext, { stage: "review" }>;
