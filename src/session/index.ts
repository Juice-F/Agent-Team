import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { WorkflowStageEnum } from "../schema.js";

export const TurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type Turn = z.infer<typeof TurnSchema>;

/**
 * 这个任务在哪个仓库上干活。用户在卡片上填的。
 *
 * 存的是「怎么把代码拉出来」，不是「代码在哪」：目录能从 source 算出来（见
 * workspace.dirOf），而目录本身随时可能不在——换台机器、或者被清掉了。照着
 * source 重新 clone 一份就是了。
 *
 * 没有分支：让人填一条分支只是多一格要敲的东西。拉下来就是仓库的默认分支。
 */
export const TaskRepoSchema = z.object({
  /** 用户填的原文，原样交给 git clone。本地路径、git@、https 都行 */
  source: z.string(),
});
export type TaskRepo = z.infer<typeof TaskRepoSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  /** 话题 ID，任务的主键 */
  threadId: z.string(),
  /** 话题所在的群 */
  chatId: z.string(),
  /**
   * 主群里那条裸消息的 message_id，也就是话题的根。
   */
  rootMessageId: z.string(),
  /** 话题助手给的短标题。clarifying 阶段可能还是空的 */
  title: z.string(),
  /**
   * 需求已经问清楚了，只差用户在卡片上把仓库填下来。
   *
   * 单独存一个字段，是因为「问清楚了」和「能开工了」现在是两件事：判成 task 之后
   * 任务还停在 clarifying 等卡片，重启捡回来得认得出它是在等填仓库，而不是还要
   * 接着追问。这个和 repo 都齐了，才交给产品。
   */
  settled: z.boolean().default(false),
  /** 在哪个仓库上干活。用户在卡片上填之前是 null */
  repo: TaskRepoSchema.nullable().default(null),
  /**
   * 需求描述。一句话就说清的就是用户原文；澄清过的是话题助手综合几轮对话后的
   * 复述——下游要看的是问清楚之后的版本，不是最初那句含糊的。
   */
  request: z.string(),
  /**
   * 各阶段和用户的往返，按阶段分开存。
   *
   * 分开是因为它们不是一回事：澄清阶段问的是「你到底要什么」，spec 阶段问的是
   * 「这个点怎么定」。混成一条的话，越往后的角色读到的越是一段掺着别人视角、
   * 只会变长的对话；打回重来时也没办法只清掉自己那一段。
   *
   * 一棒只写得到自己那一段——引擎按当前阶段并进去，见 TaskPatch。
   */
  turns: z.partialRecord(WorkflowStageEnum, z.array(TurnSchema)).default({}),
  /**
   * 产品当前这一版方案，等用户在卡片上点确认。
   *
   * 得落盘：卡片发出去之后要等人点，一等可能就跨了进程重启；而且交给研发的必须
   * 是用户眼前确认过的那一版，不能确认完再问一次模型重新生成。
   */
  plan: z.string().default(""),
  /**
   * 审查这一版的打回意见，等用户在卡片上点确认才真的返工。
   *
   * 落盘理由同 plan：卡片发出去要等人点，这一等可能跨进程重启。交回 coding 的
   * 那一刻就清空——留着的话下一轮审查通过了它还在，会被当成新意见带回去。
   */
  reviewNote: z.string().default(""),
  /**
   * 验收没过时，产品重新写出来的那份需求，等用户点确认才真的回去重拆。
   *
   * 它同时是个开关：验收那张卡片上的按钮只有一个「确认」，点下去是收工还是打回，
   * 就看这里空不空——空的是通过，有东西的是没过。
   */
  acceptNote: z.string().default(""),
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
   * 每一棒开工时手里那张交接单，按阶段存着。
   *
   * 必须落盘：流程中间要等人说话，一等可能就跨了进程重启，单子只活在内存里的
   * 话，醒过来这一棒就不知道自己该拿什么开工。形状由目标阶段声明的 schema 管，
   * Runner 在进阶段前会验一遍，所以 output 存成 unknown。
   *
   * 按阶段存而不是只留最新那张：走到后面还想知道当初是拿什么开的工——立项时的
   * 需求、拆出来的方案、每一轮改了什么。只留一张的话，交下一棒就把上一张冲掉了。
   *
   * from 是上一棒的阶段名，入口那张是 null。同一个阶段可能从两个方向进来（比如
   * spec 既可能是澄清完过来的，也可能是验收打回来的），靠它认。
   */
  stageRecord: z
    .partialRecord(
      WorkflowStageEnum,
      z.object({ from: WorkflowStageEnum.nullable(), output: z.unknown() }),
    )
    .default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

export class SessionStore {
  private get dir(): string {
    return resolve(config.sessionsDir);
  }

  private fileOf(threadId: string): string {
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

  async load(threadId: string): Promise<Session | null> {
    try {
      const raw = await readFile(this.fileOf(threadId), "utf8");
      const parsed = SessionSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async save(task: Session): Promise<Session> {
    await mkdir(this.dir, { recursive: true });
    const next: Session = { ...task, updatedAt: new Date().toISOString() };
    await writeFile(
      this.fileOf(task.threadId),
      JSON.stringify(next, null, 2),
      "utf8",
    );
    return next;
  }

  async list(): Promise<Session[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }

    const tasks: Session[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const task = await this.load(file.slice(0, -".json".length));
      if (task) tasks.push(task);
    }
    return tasks;
  }
}

export const sessionStore = new SessionStore();
