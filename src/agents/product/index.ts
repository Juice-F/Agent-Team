import { config } from "../../config.js";
import { modelFor, type OnProgress } from "../../model/index.js";
import type { Inbound, StepContext, StepResult } from "../../types.js";
import type { Turn } from "../../store/index.js";
import { BaseAgent } from "../base.js";
import * as cards from "./cards.js";
import { ACCEPT_SYSTEM, SPEC_SYSTEM } from "./prompt.js";
import {
  AcceptOutputSchema,
  ProductOutputSchema,
  type AcceptOutput,
  type ProductOutput,
} from "./schema.js";

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
        return this.accept(ctx);
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
    const prevTurns = ctx.task.turns[ctx.stage] ?? [];

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
          turns: [...prevTurns, { role: "user", text: ctx.message.text }],
        },
      };
    }

    const { card, result } = await this.think(ctx, prevTurns);
    const turns: Turn[] = [
      ...prevTurns,
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
    turns: Turn[],
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
        result: await this.decide(ctx, turns, progress.on),
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
    turns: Turn[],
    onProgress: OnProgress,
  ): Promise<ProductOutput> {
    const transcript = turns
      .map((t) => `${t.role === "user" ? "用户" : "你"}：${t.text}`)
      .join("\n");

    const parts = [
      `需求标题：${ctx.input.title || ctx.task.title}`,
      `需求描述：\n${ctx.input.request}`,
    ];
    if (transcript) parts.push(`到目前为止的对话：\n${transcript}`);
    parts.push(
      ctx.message
        ? `用户刚刚说：\n${ctx.message.text}`
        : "这个需求刚交到你手上。先看一遍，缺关键信息就问，够清楚就直接出方案。",
    );

    return modelFor("product").generate({
      system: SPEC_SYSTEM,
      user: parts.join("\n\n"),
      schema: ProductOutputSchema,
      onProgress,
      signal: ctx.signal,
    });
  }

  /**
   * 验收一轮。
   *
   * 两条出路都要人点一下才走：收工是终点，打回是产品重拆、研发重写、审查重看
   * 整整一圈。哪条都不该由模型自己拍板——最后签字的是提需求的人。
   *
   * 卡片上只有一个「确认」按钮，点下去往哪走看 acceptNote 空不空：产品判没过时
   * 会把重拆用的新需求写进去，判过了就清空。
   */
  private async accept(ctx: AcceptingContext): Promise<StepResult> {
    if (ctx.message?.confirmed) {
      if (ctx.task.acceptNote) {
        await this.bot.replyCard(
          ctx.task.rootMessageId,
          cards.reopened(ctx.task),
          { inThread: true },
        );
        return {
          kind: "next",
          to: "spec",
          output: { title: ctx.task.title, request: ctx.task.acceptNote },
          // 交回去的是一份新需求，不是让人返工的方案——所以 request 本身也换掉，
          // 重拆那一棒往后看到的都该是这一版。用掉就清，别留到下一轮。
          patch: { request: ctx.task.acceptNote, acceptNote: "" },
        };
      }

      await this.bot.replyCard(
        ctx.task.rootMessageId,
        cards.finished(ctx.task),
        { inThread: true },
      );
      // done 那一棒没人认领，summary 只是留个结论在盘上
      return { kind: "next", to: "done", output: { summary: ctx.input.summary } };
    }

    const posted = await this.bot.replyCard(
      ctx.task.rootMessageId,
      cards.checking(),
      { inThread: true },
    );
    const progress = this.bot.trackProgress(posted.messageId, cards.checking);

    let result: AcceptOutput;
    try {
      result = await this.check(ctx, progress.on);
    } catch (err) {
      await this.bot.patchCard(posted.messageId, cards.checkFailed());
      throw err;
    } finally {
      progress.stop();
    }

    if (result.verdict === "pass") {
      await this.bot.patchCard(posted.messageId, cards.checked(ctx.task, result));
      // 清空是必须的：上一轮打回留下的那份还在的话，这次点「收工」会被当成打回
      return { kind: "wait", patch: { acceptNote: "" } };
    }

    await this.bot.patchCard(posted.messageId, cards.unchecked(ctx.task, result));
    return { kind: "wait", patch: { acceptNote: result.request } };
  }

  private check(
    ctx: AcceptingContext,
    onProgress: OnProgress,
  ): Promise<AcceptOutput> {
    const parts = [
      `需求：${ctx.task.title}`,
      `用户当初要的：\n${ctx.task.request}`,
      `你自己拆的方案：\n${ctx.task.plan}`,
      `研发做完、审查也过了，交上来的说明：\n${ctx.input.summary}`,
    ];

    return modelFor("product").generate({
      system: ACCEPT_SYSTEM,
      user: parts.join("\n\n"),
      schema: AcceptOutputSchema,
      // 验收得看真东西，但不许动——发现没做到是提出来，不是自己顺手补上
      repo: { path: config.targetRepo, write: false },
      onProgress,
      signal: ctx.signal,
    });
  }
}

type SpecContext = Extract<StepContext, { stage: "spec" }>;
type AcceptingContext = Extract<StepContext, { stage: "accepting" }>;
