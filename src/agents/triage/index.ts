import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../../config.js";
import { modelFor, type OnProgress } from "../../model/index.js";
import type {
  ChannelHandler,
  FeishuChannel,
  Inbound,
} from "../../feishu/index.js";
import { workflow } from "../../workflow.js";
import * as cards from "./cards.js";
import { SYSTEM } from "./prompt.js";
import {
  TaskSchema,
  TriageOutputSchema,
  type Task,
  type TriageOutput,
  type Turn,
} from "./schema.js";

/* ------------------------------------------------------------------ *
 * 立项单的落盘
 *
 * 一个话题 = 一个任务，按 thread_id 存一个文件。进程重启后话题里的消息还要能
 * 找回对应的任务，所以放盘上而不是内存。下游（产品）直接 import loadTask。
 * ------------------------------------------------------------------ */

/** T20260805-2345-a1b2 */
export function makeTaskId(at: Date, rootMessageId: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}`;
  const suffix = rootMessageId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-4)
    .toLowerCase();
  return `T${stamp}-${suffix}`;
}

function tasksDir(): string {
  return resolve(config.sessionsDir, "tasks");
}

function fileOf(threadId: string): string {
  // thread_id 形如 omt_xxx，本身就安全；仍做一次白名单过滤防目录穿越
  const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return resolve(tasksDir(), `${safe}.json`);
}

export async function loadTask(threadId: string): Promise<Task | null> {
  try {
    const raw = await readFile(fileOf(threadId), "utf8");
    const parsed = TaskSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // 文件不存在 = 这个话题不是我发起的任务
    return null;
  }
}

export async function saveTask(task: Task): Promise<void> {
  await mkdir(tasksDir(), { recursive: true });
  const next: Task = { ...task, updatedAt: new Date().toISOString() };
  await writeFile(fileOf(task.threadId), JSON.stringify(next, null, 2), "utf8");
}

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

export class TriageHandler implements ChannelHandler {
  constructor(private readonly bot: FeishuChannel) {}

  /** 主群 @ → 判断该不该立项 */
  async onMention(msg: Inbound): Promise<void> {
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
    const task: Task = {
      id: makeTaskId(new Date(), msg.messageId),
      threadId: opened.threadId,
      chatId: msg.chatId,
      rootMessageId: msg.messageId,
      title: result.title,
      request: result.request || msg.text,
      turns: [
        { role: "user", text: msg.text },
        { role: "assistant", text: result.reply },
      ],
      // 起点：说清楚了就直接进产品那一环，没说清就先留在澄清
      stage: result.verdict === "task" ? "spec" : "clarifying",
      createdAt: now,
      updatedAt: now,
    };
    await saveTask(task);

    if (workflow.ownerOf(task.stage) === "triage") {
      await this.bot.patchCard(card, cards.threadOpened());
      return;
    }
    await this.bot.patchCard(card, cards.filed(task));
    await this.postHandOff(task);
  }

  /** 话题内消息 → 只接归我认领的阶段，流转出去之后的归下游 */
  async onThread(threadId: string, msg: Inbound): Promise<void> {
    const task = await loadTask(threadId);
    if (!task || workflow.ownerOf(task.stage) !== "triage") return;

    const result = await this.decide(task.turns, msg.text);
    const turns: Turn[] = [
      ...task.turns,
      { role: "user", text: msg.text },
      { role: "assistant", text: result.reply },
    ];

    // 还没问清楚就接着聊，纯文字。话题里已经在澄清了，chat 也当成没问清楚处理。
    if (result.verdict !== "task") {
      await saveTask({ ...task, turns });
      await this.bot.replyText(task.rootMessageId, result.reply, {
        inThread: true,
      });
      return;
    }

    // 定下来了就只上卡片。卡片本身已经说明立项了，再补一句「已交给产品经理」
    // 是同一件事说两遍。
    const next: Task = {
      ...task,
      title: result.title || task.title,
      // 产品要看的是问清楚之后的版本，不是最初那句含糊的
      request: result.request || task.request,
      turns,
      // 走图里的边，接错线当场炸
      stage: workflow.advance(task.stage, "spec"),
    };
    await saveTask(next);
    await this.postHandOff(next);
  }

  /**
   * 判断 + 追问。
   *
   * history 是这个话题里已经发生的往返，空数组就是主群里的第一次判断。历史拼进
   * prompt 而不是靠 CLI 的会话——`claude -p` 每次都是独立进程，而且我们要的上下
   * 文本来就跟着立项单落盘，进程重启后还得接着聊。
   */
  private async decide(
    history: Turn[],
    request: string,
    onProgress?: OnProgress,
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
    });
  }

  /**
   * 发占位卡片 → 判断 → 进度打在卡片上。
   *
   * 只有主群那次用：CLI 冷启动加首字延迟能有十几秒，而用户刚 @ 完什么都没有，
   * 这段必须有东西顶着。
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

  private async postHandOff(task: Task): Promise<void> {
    await this.bot.replyCard(task.rootMessageId, cards.handOff(task), {
      inThread: true,
    });
  }
}
