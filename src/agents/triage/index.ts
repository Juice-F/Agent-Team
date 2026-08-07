import { modelFor, type OnProgress } from "../../model/index.js";
import type { ChannelHandler, Inbound } from "../../feishu/index.js";
import { makeTaskId, saveTask, type Task, type Turn } from "../../store/task.js";
import type { Engine, StageContext, StepResult } from "../../workflow/index.js";
import { BaseAgent } from "../base.js";
import * as cards from "./cards.js";
import { SYSTEM } from "./prompt.js";
import { TriageOutputSchema, type TriageOutput } from "./schema.js";

/**
 * 话题助手。
 *
 * 认领 clarifying 那一棒——需求还没问清楚，在话题里接着问，问清楚了就交给产品。
 * 另外它还管一个不属于流程的入口：主群里被 @ 到时判断该不该立项。流程的每一棒
 * 都是「任务已经存在，推它往前走」，而立项要判断的恰恰是「该不该有这个任务」，
 * 判完才有单子，有了单子才轮到引擎。
 */
export class TriageAgent extends BaseAgent<"clarifying"> {
  constructor() {
    super("triage", ["clarifying"]);
  }

  async run(ctx: StageContext<"clarifying">): Promise<StepResult> {
    // 没有触发消息 = 刚开话题，追问已经发出去了，等人回话
    if (!ctx.message) return { kind: "wait" };

    const result = await this.decide(
      ctx.task.turns,
      ctx.message.text,
      undefined,
      ctx.signal,
    );
    const turns: Turn[] = [
      ...ctx.task.turns,
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

  /** 除了话题消息，还要收主群里 @ 自己的那条 —— 立项入口 */
  protected override channel(engine: Engine): ChannelHandler {
    return {
      ...super.channel(engine),
      onMention: (msg) => this.onMention(msg),
    };
  }

  /** 主群 @ → 判断该不该立项，立了就把单子交给引擎 */
  private async onMention(msg: Inbound): Promise<void> {
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
    const task: Task = {
      id: makeTaskId(new Date(), msg.messageId),
      threadId: opened.threadId,
      chatId: msg.chatId,
      rootMessageId: msg.messageId,
      title,
      request,
      turns: [
        { role: "user", text: msg.text },
        { role: "assistant", text: result.reply },
      ],
      stage,
      phase: "pending",
      // 起跑时手里那张交接单。from 是 null——这一棒不是谁交下来的。
      handoff: { from: null, output: { title, request } },
      createdAt: now,
      updatedAt: now,
    };
    await saveTask(task);

    if (stage === "clarifying") {
      await this.bot.patchCard(card, cards.threadOpened());
      return;
    }

    await this.bot.patchCard(card, cards.filed(task));
    await this.bot.replyCard(task.rootMessageId, cards.handOff(task), {
      inThread: true,
    });
    // 交给引擎，后面几棒它自己按图推
    await this.engine.resume(task);
  }

  /**
   * 判断 + 追问。
   *
   * history 是这个话题里已经发生的往返，空数组就是主群里的第一次判断。历史拼进
   * prompt 而不是靠 CLI 的会话——`claude -p` 每次都是独立进程，而且我们要的上下
   * 文本来就跟着任务落盘，进程重启后还得接着聊。
   */
  private async decide(
    history: Turn[],
    request: string,
    onProgress?: OnProgress,
    signal?: AbortSignal,
  ): Promise<TriageOutput> {
    const historyStr = history
      .map((t) => `${t.role === "user" ? "用户" : "你"}：${t.text}`)
      .join("\n");

    const user = historyStr
      ? `你和用户在话题里已经聊过：\n\n${historyStr}\n\n用户刚刚又说：\n\n${request}`
      : `用户在群里发来一条消息：\n\n${request}`;

    return modelFor("triage").generate({
      system: SYSTEM,
      user,
      schema: TriageOutputSchema,
      onProgress,
      signal,
    });
  }

  /**
   * 发占位卡片 → 判断 → 进度打在卡片上。
   *
   * 只有主群那次用：CLI 冷启动加首字延迟能有十几秒，而用户刚 @ 完什么都没有，
   * 这段必须有东西顶着。立项还没进流程，也就没有中断信号可带。
   */
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
      // 模型挂了也得给个交代，否则那张「思考中」会永远停在那
      await this.bot.patchCard(posted.messageId, cards.failed()).catch(() => {});
      throw err;
    } finally {
      progress.stop();
    }
  }
}
