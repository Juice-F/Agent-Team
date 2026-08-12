import { modelFor, type OnProgress } from "../../model/index.js";
import { router } from "../../router/index.js";
import type { Inbound, StepContext, StepResult } from "../../types.js";
import {
  sessionStore,
  type Session,
  type TaskRepo,
  type Turn,
} from "../../session/index.js";
import { workspace } from "../../workspace/index.js";
import { claimFiling, releaseFiling } from "../../redis/once.js";
import type { Posted } from "../../feishu/index.js";
import { BaseAgent } from "../base.js";
import * as cards from "./cards.js";
import { SYSTEM } from "./prompt.js";
import { TriageOutputSchema, type TriageOutput } from "./schema.js";

type ClarifyingContext = Extract<StepContext, { stage: "clarifying" }>;

export class TriageAgent extends BaseAgent {
  constructor() {
    super("triage", ["clarifying"]);
  }

  async run(ctx: StepContext): Promise<StepResult> {
    if (ctx.stage !== "clarifying") return { kind: "wait" };
    if (!ctx.message) return { kind: "wait" };

    if (ctx.message.confirmed) return this.takeRepo(ctx, ctx.message);

    const prevTurns = ctx.task.turns[ctx.stage] ?? [];

    if (ctx.task.settled) {
      await this.bot.replyCard(
        ctx.task.rootMessageId,
        cards.pickRepo(ctx.task, { why: "需求这边我够清楚了，就差一个仓库。" }),
        { inThread: true },
      );
      return {
        kind: "wait",
        patch: { turns: [...prevTurns, { role: "user", text: ctx.message.text }] },
      };
    }

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

    const title = result.title || ctx.task.title;
    // 产品要看的是问清楚之后的版本，不是最初那句含糊的
    const request = result.request || ctx.input.request;

    // 需求刚刚定下来，这才轮到问仓库。卡片分两层：上面是「需求我明白了」那句，
    // 下面是要填的东西——追问和要填的是同一件事，分两条消息只会越翻越远。
    await this.bot.replyCard(
      ctx.task.rootMessageId,
      cards.pickRepo(ctx.task, { why: result.reply }),
      { inThread: true },
    );
    return { kind: "wait", patch: { turns, title, request, settled: true } };
  }

  private async takeRepo(
    ctx: ClarifyingContext,
    msg: Inbound,
  ): Promise<StepResult> {
    const prevTurns = ctx.task.turns[ctx.stage] ?? [];
    const turns: Turn[] = [...prevTurns, { role: "user", text: msg.text }];

    const repo: TaskRepo = { source: (msg.data?.["source"] ?? "").trim() };

    const checked = await workspace.check(repo.source);
    if (!checked.ok) {
      await this.bot.replyCard(
        ctx.task.rootMessageId,
        cards.pickRepo(ctx.task, { problem: checked.problem, prefill: repo }),
        { inThread: true },
      );
      return { kind: "wait", patch: { turns } };
    }

    const task = { ...ctx.task, repo };
    await this.bot.replyCard(task.rootMessageId, cards.handOff(task), {
      inThread: true,
    });
    return {
      kind: "next",
      to: "spec",
      output: { title: task.title, request: task.request },
      patch: { turns, repo },
    };
  }

  protected override async onGroup(msg: Inbound): Promise<void> {
    if (await this.replySimpleQuery(msg)) return;

    const { card, result } = await this.think(msg);

    if (result.verdict === "chat") {
      await this.bot.patchCard(card, cards.replied(result.reply));
      return;
    }

    const settled = result.verdict === "task";

    // 飞书这边传的是主群那条消息的 id：话题就是挂在它下面开出来的，两者一一对应。
    // 钉钉那边没有话题这层，传群 id 就是「一个群只立一次项」。
    if (!(await claimFiling(msg.messageId))) {
      await this.bot.patchCard(card, cards.alreadyFiled());
      return;
    }

    let opened: Posted;
    try {
      opened = await this.bot.replyCard(msg.messageId, cards.opening(result.reply), {
        inThread: true,
      });
    } catch (err) {
      await releaseFiling(msg.messageId);
      throw err;
    }
    if (!opened.threadId) {
      await releaseFiling(msg.messageId);
      await this.bot.patchCard(card, cards.threadUnsupported());
      return;
    }

    const now = new Date().toISOString();
    const title = result.title;
    const request = result.request || msg.text;
    const draft: Session = {
      id: sessionStore.makeId(new Date(), msg.messageId),
      threadId: opened.threadId,
      chatId: msg.chatId,
      rootMessageId: msg.messageId,
      title,
      settled,
      repo: null,
      request,
      turns: {
        clarifying: [
          { role: "user", text: msg.text },
          { role: "assistant", text: result.reply },
        ],
      },
      plan: "",
      reviewNote: "",
      acceptNote: "",
      stage: "clarifying",
      phase: "waiting",
      stageRecord: { clarifying: { from: null, output: { title, request } } },
      createdAt: now,
      updatedAt: now,
    };

    const { created, task } = await sessionStore.create(draft);
    if (!created) {
      console.warn(`[triage] 话题 ${draft.threadId} 上已经有任务 ${task.id} 了`);
    }

    // 更新主群里「✅ 已立项」还是「💬 已开话题」
    await this.bot.patchCard(
      card,
      task.settled ? cards.filed(task) : cards.threadOpened(),
    );
    if (task.settled) {
      await this.bot.patchCard(
        opened.messageId,
        cards.pickRepo(task, { why: result.reply }),
      );
    }
  }

  private async replySimpleQuery(msg: Inbound): Promise<boolean> {
    const decision = await router.route(msg.text);
    console.log(`[router decision] ${JSON.stringify(decision)}`);

    if (decision.label !== "SIMPLE") return false;

    // 规则自己带了话就直接发，不走小模型答 + 大模型评那条链
    if (decision.reply) {
      await this.bot.replyText(msg.messageId, decision.reply);
      return true;
    }

    const answer = await router.answer(msg.text);
    console.log(`[router answer] ${JSON.stringify(answer)}`);

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
