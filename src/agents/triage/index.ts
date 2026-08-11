import { modelFor, type OnProgress } from "../../model/index.js";
import { router } from "../../router/index.js";
import type { Inbound, StepContext, StepResult, TaskPatch } from "../../types.js";
import {
  sessionStore,
  type Session,
  type TaskRepo,
  type Turn,
} from "../../session/index.js";
import { workspace } from "../../workspace/index.js";
import { BaseAgent } from "../base.js";
import * as cards from "./cards.js";
import { SYSTEM } from "./prompt.js";
import { TriageOutputSchema, type TriageOutput } from "./schema.js";

/**
 * 话题助手。
 *
 * 一条直线，三步，缺一步都停在 clarifying：
 *
 *   1. 聊到需求问清楚（settled，task.title / task.request 就是问清楚之后那一版）
 *   2. 这时候才把填仓库的卡片发出去，等用户填完点确认（repo）
 *   3. 把代码拉到工作区，拉下来了才交给产品经理
 *
 * 顺序是死的：需求还在聊的时候不发卡片。那会儿这个需求最后落到哪个仓库、要不要
 * 做，都还没定——先摆个输入框在那儿，用户填了也是白填，聊崩了更是白拉一个仓库。
 */
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

  /**
   * 用户在卡片上把仓库填下来了。
   *
   * 走到这儿需求一定已经定了——卡片就是那时候才发的。所以填对了就直接往下走，不用
   * 再看一眼需求那边到底怎么样。
   *
   * 先验一下再收：手打一长串地址，敲错一个字符是常事，不验这一下就要等到 clone
   * 跑起来才发现。
   */
  private async takeRepo(
    ctx: ClarifyingContext,
    msg: Inbound,
  ): Promise<StepResult> {
    const prevTurns = ctx.task.turns[ctx.stage] ?? [];
    const turns: Turn[] = [...prevTurns, { role: "user", text: msg.text }];

    const repo: TaskRepo = { source: (msg.data?.["source"] ?? "").trim() };

    const checked = await workspace.check(repo.source);
    if (!checked.ok) {
      // 哪儿不对写在同一张卡片上再发一次，填的那份原样预填回去——让他改错的那一
      // 处，别整串重敲。不落盘：没验过的地址不该被记成这个任务的仓库。
      await this.bot.replyCard(
        ctx.task.rootMessageId,
        cards.pickRepo(ctx.task, { problem: checked.problem, prefill: repo }),
        { inThread: true },
      );
      return { kind: "wait", patch: { turns } };
    }

    return this.handOff({ ...ctx.task, repo }, { turns, repo });
  }

  /**
   * 交给产品：先把代码拉下来，再交棒。
   *
   * clone 放在这儿而不是等研发开工才拉，是因为产品拆方案就已经要看代码了；拉不
   * 下来也该在这一刻就说，别等走到写代码那一棒才发现仓库根本不对。
   *
   * 拉不下来就停在原地：需求那部分照样落盘（patch 带着），用户改完再点一次卡片就
   * 能接着走。
   */
  private async handOff(
    task: Session & { repo: TaskRepo },
    patch: TaskPatch,
  ): Promise<StepResult> {
    const posted = await this.bot.replyCard(
      task.rootMessageId,
      cards.preparing(task.repo),
      { inThread: true },
    );

    try {
      await workspace.ensure(task);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.bot.patchCard(
        posted.messageId,
        cards.prepareFailed(task.repo, reason),
      );
      await this.bot.replyCard(
        task.rootMessageId,
        cards.pickRepo(task, { why: "换个仓库再试一次。" }),
        { inThread: true },
      );
      return { kind: "wait", patch };
    }

    await this.bot.patchCard(posted.messageId, cards.handOff(task));
    return {
      kind: "next",
      to: "spec",
      output: { title: task.title, request: task.request },
      patch,
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

    const opened = await this.bot.replyCard(
      msg.messageId,
      cards.opening(result.reply),
      { inThread: true },
    );
    if (!opened.threadId) {
      await this.bot.patchCard(card, cards.threadUnsupported());
      return;
    }

    const now = new Date().toISOString();
    const title = result.title;
    const request = result.request || msg.text;
    const task: Session = {
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
    await sessionStore.save(task);

    // 更新主群里「✅ 已立项」还是「💬 已开话题」
    await this.bot.patchCard(
      card,
      settled ? cards.filed(task) : cards.threadOpened(),
    );
    if (settled) {
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

type ClarifyingContext = Extract<StepContext, { stage: "clarifying" }>;
