import { modelFor, type OnProgress } from "../../model/index.js";
import type { Inbound, StepContext, StepResult } from "../../types.js";
import type { Turn } from "../../store/index.js";
import { BaseAgent } from "../base.js";
import * as cards from "./cards.js";
import { SYSTEM } from "./prompt.js";
import { ProductOutputSchema, type ProductOutput } from "./schema.js";

/**
 *
 *   spec       拿澄清完的需求，跟用户来回确认，拆成研发能照着写的方案
 *   accepting  拿审查通过的那轮改动验收；通过交给 done，不通过打回 spec 自己重拆
 *
 */
export class ProductAgent extends BaseAgent {
  constructor() {
    super("product", ["spec", "accepting"]);
  }

  async run(ctx: StepContext): Promise<StepResult> {
    switch (ctx.stage) {
      case "spec":
        return this.spec(ctx);
      case "accepting":
        return this.pending(ctx, `验收：${ctx.input.summary}`);
      default:
        return { kind: "wait" };
    }
  }

  protected async onGroup(_msg: Inbound): Promise<void> {}

  /**
   * 拆解一轮。
   *
   * 停在这一棒的时间里，用户在话题里说的每一句、点的每一个按钮，都会再进来一次
   * ——多轮就是这么来的，不在这个方法里循环。
   */
  private async spec(ctx: SpecContext): Promise<StepResult> {
    // 只读自己这一段。澄清阶段那几轮不看——问清楚之后的复述就在 request 里，
    // 再把话题助手的往返读一遍只是噪音。
    const history = ctx.task.turns[ctx.stage] ?? [];

    // 点了「就按这个做」：他认可的是卡片上那一版，直接拿盘上存的那份交棒。
    // 再问一次模型的话，拿回来的可能已经不是他看过的方案了。
    if (ctx.message?.confirmed && ctx.task.plan) {
      await this.bot.replyCard(ctx.task.rootMessageId, cards.handOff(ctx.task), {
        inThread: true,
      });
      return {
        kind: "next",
        to: "coding",
        output: { plan: ctx.task.plan, note: "" },
        patch: {
          turns: [...history, { role: "user", text: ctx.message.text }],
        },
      };
    }

    const { card, result } = await this.think(ctx, history);
    const turns: Turn[] = [
      ...history,
      // 被上一棒推起来的那次没有用户消息，这一轮就只有自己说的话
      ...(ctx.message
        ? [{ role: "user", text: ctx.message.text } satisfies Turn]
        : []),
      { role: "assistant", text: result.reply },
    ];

    // 还有点没定，问完停下等人拍板
    if (result.verdict === "ask") {
      await this.bot.patchCard(card, cards.asking(ctx.task, result));
      return { kind: "wait", patch: { turns } };
    }

    // 出了方案也不能自己往下走，等用户点确认。plan 落盘，因为这一等可能跨进程重启。
    await this.bot.patchCard(card, cards.drafted(ctx.task, result));
    return { kind: "wait", patch: { turns, plan: result.plan } };
  }

  private async think(
    ctx: SpecContext,
    history: Turn[],
  ): Promise<{ card: string; result: ProductOutput }> {
    const posted = await this.bot.replyCard(
      ctx.task.rootMessageId,
      cards.thinking(),
      { inThread: true },
    );
    const progress = this.bot.trackProgress(posted.messageId, cards.thinking);
    try {
      return {
        card: posted.messageId,
        result: await this.decide(ctx, history, progress.on),
      };
    } catch (err) {
      await this.bot.patchCard(posted.messageId, cards.failed());
      throw err;
    } finally {
      progress.stop();
    }
  }

  private decide(
    ctx: SpecContext,
    history: Turn[],
    onProgress: OnProgress,
  ): Promise<ProductOutput> {
    const historyStr = history
      .map((t) => `${t.role === "user" ? "用户" : "你"}：${t.text}`)
      .join("\n");

    const parts = [
      `需求标题：${ctx.input.title || ctx.task.title}`,
      `需求描述：\n${ctx.input.request}`,
    ];
    if (historyStr) parts.push(`到目前为止的对话：\n${historyStr}`);
    parts.push(
      ctx.message
        ? `用户刚刚说：\n${ctx.message.text}`
        : "这个需求刚交到你手上。先看一遍，缺关键信息就问，够清楚就直接出方案。",
    );

    return modelFor("product").generate({
      system: SYSTEM,
      user: parts.join("\n\n"),
      schema: ProductOutputSchema,
      onProgress,
      signal: ctx.signal,
    });
  }
}

type SpecContext = Extract<StepContext, { stage: "spec" }>;
