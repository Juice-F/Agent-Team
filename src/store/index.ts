import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { WorkflowStageEnum } from "../schema.js";

/**
 * 一个任务的全部状态，以及它的落盘。
 *
 * 一个话题 = 一个任务，按 thread_id 存一个文件。进程重启后话题里的消息还要能
 * 找回对应的任务，走到哪、上一棒交下来什么，都得在盘上。
 *
 * 这东西不属于哪个角色——它是在流程里流动的那张单子。写成类是留余地：往后各阶段
 * 会有各自要存的中间产物（产品的 tasks.md、研发的 diff），那些按阶段加方法，
 * 别都塞进这一张单子里。
 */

/**
 * 澄清阶段的一来一回。
 *
 * 存下来是因为 `claude -p` 每次调用都是独立进程，没有会话——上下文只能由我们
 * 自己带。跟着任务落盘，进程重启后接着聊。
 */
export const TurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  /** 话题 ID，任务的主键 */
  threadId: z.string(),
  /** 话题所在的群 */
  chatId: z.string(),
  /**
   * 主群里那条裸消息的 message_id，也就是话题的根。
   * 之后往这个话题里发东西，一律 reply 到它 + reply_in_thread。
   */
  rootMessageId: z.string(),
  /** 话题助手给的短标题。clarifying 阶段可能还是空的 */
  title: z.string(),
  /**
   * 需求描述。一句话就说清的就是用户原文；澄清过的是话题助手综合几轮对话后的
   * 复述——下游要看的是问清楚之后的版本，不是最初那句含糊的。
   */
  request: z.string(),
  /** 澄清阶段的往返。立项之后不再追加，下游各自管自己的状态。 */
  turns: z.array(TurnSchema).default([]),
  /** 流程走到哪了。图在 src/workflow/index.ts，谁认领这个阶段引擎那儿查。 */
  stage: WorkflowStageEnum,
  /**
   * 这一棒的状态。
   *
   *   pending  交接单到了还没开工，或者跑到一半被打断了，等着重跑
   *   running  正在跑
   *   waiting  跑完了，停下来等人说话（终点也算，反正没人再推它）
   *
   * 中断恢复全靠它：进程死在半路，文件里留着的就是 running，下次启动一眼看得
   * 出这棒没跑完。只有 waiting 是「本来就该停在这」，别去动它。
   */
  phase: z.enum(["pending", "running", "waiting"]).default("pending"),
  /**
   * 上一棒交下来的东西。
   *
   * 必须落盘：流程中间要等人说话，一等可能就跨了进程重启，交接单只活在内存里
   * 的话，醒过来这一棒就不知道自己该拿什么开工。形状由目标阶段声明的 schema
   * 管，Runner 在进阶段前会验一遍，所以这里存成 unknown。
   */
  handoff: z
    .object({ from: WorkflowStageEnum.nullable(), output: z.unknown() })
    .nullable()
    .default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export class TaskStore {
  private get dir(): string {
    return resolve(config.sessionsDir, "tasks");
  }

  private fileOf(threadId: string): string {
    // thread_id 形如 omt_xxx，本身就安全；仍做一次白名单过滤防目录穿越
    const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return resolve(this.dir, `${safe}.json`);
  }

  /** T20260805-2345-a1b2 */
  makeId(at: Date, rootMessageId: string): string {
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

  async load(threadId: string): Promise<Task | null> {
    try {
      const raw = await readFile(this.fileOf(threadId), "utf8");
      const parsed = TaskSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      // 文件不存在 = 这个话题不是我发起的任务
      return null;
    }
  }

  /** 落盘，并把盘上那一份还回去——引擎每一棒都接着用它往下推 */
  async save(task: Task): Promise<Task> {
    await mkdir(this.dir, { recursive: true });
    const next: Task = { ...task, updatedAt: new Date().toISOString() };
    await writeFile(
      this.fileOf(task.threadId),
      JSON.stringify(next, null, 2),
      "utf8",
    );
    return next;
  }

  /**
   * 盘上所有任务。启动时用它挑出中断在半路的。
   *
   * 读不动或者形状对不上的文件直接跳过——一个坏文件不该让整个进程起不来，何况
   * 多半是老版本写的，重跑那一棒也救不回来。
   */
  async list(): Promise<Task[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      // 目录还没建 = 一个任务都还没有
      return [];
    }

    const tasks: Task[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const task = await this.load(file.slice(0, -".json".length));
      if (task) tasks.push(task);
    }
    return tasks;
  }
}

export const taskStore = new TaskStore();
