import { modelFor, type OnProgress } from "../../model/index.js";
import { router } from "../../router/index.js";
import type { Inbound, StepContext, StepResult } from "../../types.js";
import { sessionStore, type Session, type Turn } from "../../session/index.js";
import { BaseAgent } from "../base.js";
import * as cards from "./cards.js";
import { SYSTEM } from "./prompt.js";
import { TriageOutputSchema, type TriageOutput } from "./schema.js";

export class TriageAgent extends BaseAgent {
  constructor() {
    super("triage", ["clarifying"]);
  }

  async run(ctx: StepContext): Promise<StepResult> {
    if (ctx.stage !== "clarifying") return { kind: "wait" };
    if (!ctx.message) return { kind: "wait" };

    const prevTurns = ctx.task.turns[ctx.stage] ?? [];
    const result = await this.decide(
      prevTurns,
      ctx.message.text,
      undefined,
      ctx.signal,
    );
    const turns: Turn[] = [
      ...prevTurns,
      { role: "user", text: ctx.message.text },
      { role: "assistant", text: result.reply },
    ];

    // 还没问清楚就接着聊，纯文字。话题里已经在澄清了，chat 也当成没问清楚处理。
    if (result.verdict !== "task") {
      await this.bot.replyText(ctx.task.rootMessageId, result.reply, {
        inThread: true,
      });
      return { kind: "wait", patch: { turns } };
    }

    // 定下来了就只上卡片。卡片本身已经说明立项了，再补一句「已交给产品经理」
    // 是同一件事说两遍。
    const title = result.title || ctx.task.title;
    // 产品要看的是问清楚之后的版本，不是最初那句含糊的
    const request = result.request || ctx.input.request;
    await this.bot.replyCard(
      ctx.task.rootMessageId,
      cards.handOff({ ...ctx.task, title, request }),
      { inThread: true },
    );

    return {
      kind: "next",
      to: "spec",
      output: { title, request },
      patch: { turns, title, request },
    };
  }

  protected override async onGroup(msg: Inbound): Promise<void> {
    if (await this.replySimpleQuery(msg)) return;

    const { card, result } = await this.think(msg);

    if (result.verdict === "chat") {
      await this.bot.patchCard(card, cards.replied(result.reply));
      return;
    }

    // task 和 ask 都开话题：说清楚了就直接立项，没说清就在话题里接着问。
    const opened = await this.bot.replyText(msg.messageId, result.reply, {
      inThread: true,
    });
    if (!opened.threadId) {
      await this.bot.patchCard(card, cards.threadUnsupported());
      return;
    }

    const now = new Date().toISOString();
    const title = result.title;
    const request = result.request || msg.text;
    // 起点：说清楚了就直接进产品那一环，没说清就先留在澄清
    const stage = result.verdict === "task" ? "spec" : "clarifying";
    const task: Session = {
      id: sessionStore.makeId(new Date(), msg.messageId),
      threadId: opened.threadId,
      chatId: msg.chatId,
      rootMessageId: msg.messageId,
      title,
      request,
      // 这一段是澄清阶段的对话，哪怕直接立项跳过了 clarifying 也记在它名下
      turns: {
        clarifying: [
          { role: "user", text: msg.text },
          { role: "assistant", text: result.reply },
        ],
      },
      // 方案和审查意见都是下游那几棒的产物，立项时还没有
      plan: "",
      reviewNote: "",
      acceptNote: "",
      stage,
      phase: "pending",
      // 起跑时手里那张交接单，记在起跑那一棒名下。from 是 null——不是谁交下来的。
      stageRecord: { [stage]: { from: null, output: { title, request } } },
      createdAt: now,
      updatedAt: now,
    };
    await sessionStore.save(task);

    if (stage === "clarifying") {
      await this.bot.patchCard(card, cards.threadOpened());
      return;
    }

    await this.bot.patchCard(card, cards.filed(task));
    await this.bot.replyCard(task.rootMessageId, cards.handOff(task), {
      inThread: true,
    });
    // 直接开话题并立项，艾特产品经理接收任务
    await this.runner.resume(task, this);
  }

  private async replySimpleQuery(msg: Inbound): Promise<boolean> {
    const decision = await router.route(msg.text);
    console.log(
      `[router] ${decision.label} ${decision.confidence.toFixed(2)} by ${decision.by}` +
        (decision.rule ? `（${decision.rule}）` : ""),
    );
    if (decision.label !== "SIMPLE") return false;

    const answer = await router.answer(msg.text);
    if (answer.kind === "escalate") {
      const score = answer.score === null ? "-" : String(answer.score);
      console.log(
        `[router] ${answer.why} ${score} 分，退回立项需求澄清：${answer.reason}`,
      );
      return false;
    }

    await this.bot.replyText(msg.messageId, answer.reply);
    return true;
  }

  private async decide(
    turns: Turn[],
    request: string,
    onProgress?: OnProgress,
    signal?: AbortSignal,
  ): Promise<TriageOutput> {
    const transcript = turns
      .map((t) => `${t.role === "user" ? "用户" : "你"}：${t.text}`)
      .join("\n");

    const user = transcript
      ? `你和用户在话题里已经聊过：\n\n${transcript}\n\n用户刚刚又说：\n\n${request}`
      : `用户在群里发来一条消息：\n\n${request}`;

    return modelFor("triage").generate({
      system: SYSTEM,
      user,
      schema: TriageOutputSchema,
      onProgress,
      signal,
    });
  }

  private async think(
    msg: Inbound,
  ): Promise<{ card: string; result: TriageOutput }> {
    const posted = await this.bot.replyCard(msg.messageId, cards.thinking());
    const progress = this.bot.trackProgress(posted.messageId, cards.thinking);
    try {
      return {
        card: posted.messageId,
        result: await this.decide([], msg.text, progress.on),
      };
    } catch (err) {
      await this.bot.patchCard(posted.messageId, cards.failed());
      throw err;
    } finally {
      progress.stop();
    }
  }
}
