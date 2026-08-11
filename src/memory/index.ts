import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { config } from "../config.js";

/**
 * 记忆分四类，因为它们的触发时机和衰减速度根本不一样：
 *
 *   user       用户是谁。角色、技术背景、口味。基本不变，用来定说话的方式——
 *              「Go 写了十年第一次碰 React」，讲前端就该拿后端打比方。
 *   feedback   用户对我们行为的纠正和确认。最重要的一类，直接改行为模式。
 *              纠正和「这么干是对的」都要存：只存纠正会让人越来越缩手缩脚，
 *              光知道什么不能做，不知道什么已经被验证过。
 *   project    进行中的活儿、决定、截止日期。衰减最快，过期就是噪音。存之前
 *              把「下周四」换算成「2026-05-07」，不然一个月后没人知道指哪天。
 *   reference  东西在哪。看板、面板、文档地址。让人知道去哪儿找，不是内容本身。
 */
export const MemoryTypeEnum = z.enum([
  "user",
  "feedback",
  "project",
  "reference",
]);
export type MemoryType = z.infer<typeof MemoryTypeEnum>;

/** 落在文件头上的那三行 YAML */
/**
 * 日期只到天。
 *
 * 记忆的时效本来就是按天算的（「2026-04-15 前冻结」「三个月没碰过」），秒级精度
 * 没人看；而且这行字要占索引那 150 字符里的十个，越短越好。
 *
 * 用 preprocess 是因为 YAML 会把不带引号的 2026-08-11 直接解析成 Date——文件是
 * 给人手改的，不能要求他记得加引号。
 */
const DaySchema = z.preprocess(
  (value) => (value instanceof Date ? toDay(value) : value),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期得是 YYYY-MM-DD"),
);

const FrontmatterSchema = z.object({
  name: z.string().min(1),
  /**
   * 这条记忆讲的是什么范围的事——不是内容，是「什么时候该翻它出来」。
   *
   * 精选注入靠的就是这一句：判断跟当前任务相不相关时只看得到它，看不到正文。
   * 写「包管理器、测试框架、commit 规范等项目约定」，别写「见正文」。
   */
  description: z.string().min(1),
  type: MemoryTypeEnum,
  /**
   * 头一次记下来的日子，之后覆盖也不变。
   *
   * 和 updatedAt 分开是为了看得出「记了半年一直在用」和「上周刚记的」——同样是
   * 昨天更新过，这两条的可信度不一样。
   *
   * 两个日期都是可选的：旧文件、手写的文件都可能没有，缺了就拿文件 mtime 兜底，
   * 不能因为少一行 frontmatter 就把整条记忆判死。
   */
  createdAt: DaySchema.optional(),
  /**
   * 最后一次写入的日子，清理就看它。
   *
   * 注意它是「最后一次写」不是「最后一次用」——读一条记忆不会刷新这个日期。想
   * 要「最近没用过就清掉」得另外记访问，那是另一件事，这里不掺。
   */
  updatedAt: DaySchema.optional(),
});

export const MemorySchema = FrontmatterSchema.required({
  createdAt: true,
  updatedAt: true,
}).extend({
  /**
   * 文件名（不含 .md），唯一键。
   *
   * 不进 frontmatter：文件名本身就是它，写两遍迟早对不上。读的时候从文件名填。
   */
  slug: z.string().min(1),
  /** frontmatter 之后的正文。feedback/project 记得带上 **Why:** / **How to apply:** */
  body: z.string(),
});
export type Memory = z.infer<typeof MemorySchema>;

/**
 * 要写进去的一条。日期不用自己填——updatedAt 由 save 盖，createdAt 沿用磁盘上
 * 那条的（没有就是今天）。导入旧记忆时可以显式指定 createdAt。
 */
export const MemoryDraftSchema = MemorySchema.partial({
  createdAt: true,
  updatedAt: true,
});
export type MemoryDraft = z.infer<typeof MemoryDraftSchema>;

/** 本地时区的 YYYY-MM-DD。用本地不用 UTC：清理是人按自己的日历判断的 */
function toDay(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/** 索引里分组用的中文名，纯给人看 */
const typeLabel: Record<MemoryType, string> = {
  user: "用户画像",
  feedback: "行为反馈",
  project: "项目动态",
  reference: "外部资源",
};

const typeOrder: readonly MemoryType[] = ["user", "feedback", "project", "reference"];
const INDEX_FILE = "MEMORY.md";
const MAX_INDEX_LINES = 200;
const MAX_LINE_CHARS = 150;

const INDEX_HEADER = [
  "# MEMORY",
  "",
  "<!-- 自动生成，别手改：save/remove 之后整份重写，改了会被冲掉 -->",
];

/**
 * 双层记忆。
 *
 * 第一层 MEMORY.md 是目录页，每行一条指针，会话开始时整份加载；第二层是一堆
 * 独立的 .md，正文按需读。分两层是因为这两件事的约束相反：目录要全（不然想不起
 * 来自己记过什么），正文要长（不然记了也用不上）。合成一个文件的话，要么目录不全，
 * 要么开场就吃掉几千 token。
 *
 * MEMORY.md 是纯派生物——每次写都从磁盘上的记忆文件重算。手改会被冲掉，但也因此
 * 不存在「索引和文件对不上」这种要人去修的中间状态。
 */
export class MemoryStore {
  private get dir(): string {
    return resolve(config.memoryDir);
  }

  /**
   * 归一化成文件名。大小写、空格、标点全抹平，中文原样保留。
   *
   * 归一化不是为了好看，是为了「同一条记忆」只有一个键：写 "Deploy Freeze" 和
   * "deploy-freeze" 得落到同一个文件上，否则同一件事会攒出好几条。
   */
  slugify(raw: string): string {
    const slug = raw
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) throw new Error(`记忆名 ${JSON.stringify(raw)} 归一化之后是空的`);
    // Windows 上文件名不分大小写，memory.md 会和索引文件 MEMORY.md 撞车
    if (slug === "memory") throw new Error("记忆名不能叫 memory，和索引文件重名");
    return slug;
  }

  private fileOf(slug: string): string {
    return resolve(this.dir, `${this.slugify(slug)}.md`);
  }

  async read(slug: string): Promise<Memory | null> {
    const file = this.fileOf(slug);
    try {
      const [raw, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      return this.parse(this.slugify(slug), raw, info.mtimeMs);
    } catch {
      return null;
    }
  }

  /** 全部记忆，按类型分组顺序排，同组内新写的在前 */
  async list(): Promise<Memory[]> {
    return (await this.scan()).map((e) => e.memory);
  }

  /**
   * 多久没更新过的那些，给定时清理用。
   *
   * 只挑出来不动手：哪条过期了得看内容——冻结令过了日子就是垃圾，用户画像放三年
   * 也还是对的。所以这里给的是「该看一眼的清单」，删不删调用方定。
   */
  async stale(days: number): Promise<Memory[]> {
    const line = new Date();
    line.setDate(line.getDate() - days);
    const cutoff = toDay(line);
    // 日期是 YYYY-MM-DD，字典序就是时间序
    return (await this.list()).filter((m) => m.updatedAt < cutoff);
  }

  /**
   * 写一条记忆并重算索引。同 slug 的整条覆盖——记忆是「当前是什么样」，不是流水账，
   * 攒着旧版本只会让后面读到的自相矛盾。
   */
  async save(input: MemoryDraft): Promise<Memory> {
    const draft = MemoryDraftSchema.parse({
      ...input,
      slug: this.slugify(input.slug),
    });
    const today = toDay(new Date());
    // createdAt 沿用盘上那条的：覆盖是「这条记忆变了」，不是「换了条新记忆」
    const previous = draft.createdAt ? null : await this.read(draft.slug);
    const memory: Memory = {
      ...draft,
      createdAt: draft.createdAt ?? previous?.createdAt ?? today,
      updatedAt: today,
    };

    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileOf(memory.slug), this.render(memory), "utf8");
    await this.rebuild();
    return memory;
  }

  /**
   * 删一条。过期的（尤其是 project）就该删，留着会被当成现状用。
   *
   * 返回原来在不在，方便调用方分清「删掉了」和「本来就没有」。
   */
  async remove(slug: string): Promise<boolean> {
    const file = this.fileOf(slug);
    let existed = true;
    try {
      await stat(file);
    } catch {
      existed = false;
    }
    if (existed) await rm(file, { force: true });
    await this.rebuild();
    return existed;
  }

  /** 会话开始时塞进 system prompt 的那份目录页；一条都没有就是空串 */
  async index(): Promise<string> {
    try {
      return await readFile(resolve(this.dir, INDEX_FILE), "utf8");
    } catch {
      return "";
    }
  }

  /**
   * 按 slug 把正文取出来拼成一段，给精选注入用。
   *
   * 认不出来的 slug 直接跳过：目录页在模型的上下文里可能已经是旧的了，为一个删掉的
   * 名字把整轮任务掀了不划算。
   */
  async recall(slugs: readonly string[]): Promise<string> {
    const blocks: string[] = [];
    for (const slug of slugs) {
      const memory = await this.read(slug).catch(() => null);
      if (!memory) continue;
      blocks.push(
        `### ${memory.name}（${memory.type}）\n${memory.body.trim()}`,
      );
    }
    return blocks.join("\n\n");
  }

  /** 从磁盘上的记忆文件整份重算 MEMORY.md，返回写进去的内容 */
  async rebuild(): Promise<string> {
    const entries = await this.scan();
    const text = this.renderIndex(entries.map((e) => e.memory));
    await mkdir(this.dir, { recursive: true });
    await writeFile(resolve(this.dir, INDEX_FILE), text, "utf8");
    return text;
  }

  /** 扫目录并排好序。mtime 只在排序兜底时用得上，对外只给 Memory */
  private async scan(): Promise<{ memory: Memory; mtime: number }[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }

    const entries: { memory: Memory; mtime: number }[] = [];
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      if (file.toLowerCase() === INDEX_FILE.toLowerCase()) continue;
      const slug = file.slice(0, -".md".length);
      const path = resolve(this.dir, file);
      let raw: string;
      let mtime: number;
      try {
        raw = await readFile(path, "utf8");
        mtime = (await stat(path)).mtimeMs;
      } catch {
        continue;
      }
      // 手写坏了的文件跳过就行，不能因为一条读不出来就把整份索引搞没
      const memory = this.parse(slug, raw, mtime);
      if (memory) entries.push({ memory, mtime });
    }

    entries.sort((a, b) => {
      const byType =
        typeOrder.indexOf(a.memory.type) - typeOrder.indexOf(b.memory.type);
      if (byType !== 0) return byType;
      // 同一天写的分不出先后，拿 mtime 兜底
      const byDay = b.memory.updatedAt.localeCompare(a.memory.updatedAt);
      return byDay !== 0 ? byDay : b.mtime - a.mtime;
    });
    return entries;
  }

  /**
   * YAML 手写坏了 gray-matter 会抛，当成读不出来处理。
   *
   * 日期缺了不算坏——旧文件、人手写的文件都可能没有，拿文件 mtime 那天兜底。判死
   * 一条记忆的代价比日期不准大得多，而且下次 save 就会把真日期补上。
   */
  private parse(slug: string, raw: string, mtime: number): Memory | null {
    let file: matter.GrayMatterFile<string>;
    try {
      file = matter(raw);
    } catch {
      return null;
    }

    const front = FrontmatterSchema.safeParse(file.data);
    if (!front.success) return null;
    const fallback = toDay(new Date(mtime));
    return {
      ...front.data,
      createdAt: front.data.createdAt ?? front.data.updatedAt ?? fallback,
      updatedAt: front.data.updatedAt ?? fallback,
      slug,
      body: file.content.trim(),
    };
  }

  /** 值里的冒号、引号、换行交给 gray-matter 的 YAML dump 去转义 */
  private render(memory: Memory): string {
    // 字段顺序写死，不靠对象展开——文件是给人看的，顺序天天变 diff 就没法看了
    return matter.stringify(`\n${memory.body.trim()}\n`, {
      name: memory.name,
      description: memory.description,
      type: memory.type,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    });
  }

  private renderIndex(memories: readonly Memory[]): string {
    const lines = [...INDEX_HEADER];
    // 留一行给「还有 N 条没列出」，不然超额的时候连这句都写不下
    const budget = MAX_INDEX_LINES - 1;
    let omitted = 0;

    for (const type of typeOrder) {
      const group = memories.filter((m) => m.type === type);
      if (group.length === 0) continue;
      // 组头占两行（空行 + 标题），放不下整个组头就别开这个组了
      if (lines.length + 2 >= budget) {
        omitted += group.length;
        continue;
      }
      lines.push("", `## ${type}（${typeLabel[type]}）`);
      for (const memory of group) {
        if (lines.length >= budget) {
          omitted += 1;
          continue;
        }
        lines.push(indexLine(memory));
      }
    }

    if (omitted > 0) {
      lines.push(
        `- …还有 ${omitted} 条没列进来（索引上限 ${MAX_INDEX_LINES} 行），该清一清过期的了`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}

/**
 * 一条指针：`- [标题](slug.md) · 2026-08-11 — 一句话`
 *
 * 后面那句直接用 description，不另写一份摘要：两份说法早晚会漂，而且判断「这条跟
 * 当前任务有没有关系」的本来就是它，目录页和精选注入看到的该是同一句话。
 *
 * 日期摆在正中间，是因为它同时管两件事：清理的时候一眼扫得出哪条老了；读的时候
 * 也用得上——「三个月前记的部署冻结」和「昨天记的」，可信度差着量级。
 */
function indexLine(memory: Memory): string {
  const head = `- [${memory.name}](${memory.slug}.md) · ${memory.updatedAt} — `;
  const room = MAX_LINE_CHARS - head.length;
  const tail = memory.description.replace(/\s+/g, " ").trim();
  return head + (tail.length > room ? `${tail.slice(0, Math.max(room - 1, 1))}…` : tail);
}

export const memoryStore = new MemoryStore();
