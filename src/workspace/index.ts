import { spawn } from "node:child_process";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Session, TaskRepo } from "../session/index.js";

export class WorkspaceError extends Error {}

/** 探一下仓库通不通。用户手打的地址，敲错一个字符是常事，别等 clone 才发现。 */
const PROBE_TIMEOUT_MS = 30_000;
/** clone 的超时。第一次拉一个大仓库能跑很久，但也不能没有底。 */
const CLONE_TIMEOUT_MS = 600_000;

/**
 * 工作区的根，落在系统临时目录下。
 *
 * 不放在进程工作目录，是因为它本来就不是这个项目的东西：clone 出来的代码是可重建
 * 的派生物，每台机器各拉各的，不该跟着代码库走，也不该指望它在机器之间共享。
 */
const ROOT = resolve(tmpdir(), "agent-team", "works");

/**
 * 多久没人用就清掉。
 *
 * 算的是「上次有人开工到现在」，不是「什么时候拉的」——每次 ensure 都会盖一下戳，
 * 所以还在推进的任务，工作区一直是新的；真正被清掉的是那些聊崩了、或者早就收工的
 * 仓库。定在一天：比最长的一棒（研发 1 小时）宽出一个量级，同时又不至于让临时目录
 * 无限长大。
 */
const IDLE_TTL_MS = 24 * 3600_000;

/**
 * 上次开工时间的戳记，放在 `.git/` 里。
 *
 * 放进 `.git/` 而不是工作树，这样它既不会出现在 `git status` 里被角色当成自己的改动，
 * 也跟着 clone 一起生灭，不用另外维护一份索引。
 */
const STAMP_FILE = "agent-team-used-at";

/** git 地址：带协议的，或者 git@host:org/repo 这种 scp 写法 */
const GIT_URL = /^(https?|ssh|git|file):\/\/|^[\w.+-]+@[\w.-]+:/i;
/** 本机路径：盘符开头、斜杠开头、UNC、或者 ./ ../ */
const LOCAL_PATH = /^[a-zA-Z]:[\\/]|^[\\/]|^\.{1,2}[\\/]/;

/** 仓库地址里给人看的那截：去掉路径和 .git，剩下仓库名 */
export function repoName(source: string): string {
  const tail = source.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return tail.replace(/\.git$/i, "") || source;
}

/** 卡片上给人看的那行 */
export function repoLabel(repo: TaskRepo): string {
  return repoName(repo.source);
}

/** 填的东西不对，这是要摆到卡片上给用户看的那几句 */
export interface RepoProblem {
  /** 卡片标题，一眼看出是哪一种不对 */
  readonly title: string;
  /** 一句话说清该怎么改 */
  readonly hint: string;
  /** git 自己说的话，折叠起来给想深究的人看 */
  readonly detail?: string;
}

export type RepoCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: RepoProblem };

function bad(title: string, hint: string, detail?: string): RepoCheck {
  return { ok: false, problem: { title, hint, ...(detail && { detail }) } };
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 代码放在哪、怎么弄下来，都归它管。
 *
 * 对外就三件事：验一个用户填的地址（check）、把目录准备好（ensure）、算出目录在哪
 * （dirOf）。git 怎么调、超时多少、半个目录怎么收拾，都关在里面——外面那几棒只想
 * 要一个能进去干活的路径。
 */
export class Workspace {
  /**
   * 这个仓库的工作区路径：`<临时目录>/agent-team/works/<仓库名>`。
   *
   * 按仓库分目录，不按任务——同一个仓库只在盘上留一份，一个大仓库拉一次就够了，
   * 目录名也是人能认出来的那个。代价是同一个仓库上并行的两个任务共用一份工作树，
   * 会看见对方改到一半的文件。
   */
  dirOf(repo: TaskRepo): string {
    const safe = repoName(repo.source).replace(/[^a-zA-Z0-9_.-]/g, "_");
    return resolve(ROOT, safe);
  }

  /**
   * 用户在卡片上填完，先验一遍再收。
   *
   * 分门别类地说哪儿不对：填空了、地址看不懂、本机路径不存在、目录在但不是 git 仓库、
   * 远端连不上——这几种要做的事完全不一样，糊成一句「仓库有问题」等于让用户自己猜。
   */
  async check(source: string): Promise<RepoCheck> {
    if (!source) {
      return bad(
        "仓库还没填",
        "填本地路径（比如 `D:\\Project\\your-repo`）或者 git 地址（比如 `git@github.com:org/repo.git`）。",
      );
    }

    const local = LOCAL_PATH.test(source);
    if (!local && !GIT_URL.test(source)) {
      return bad(
        "这个地址看不懂",
        `「${source}」既不像本地路径也不像 git 地址。本地路径要写全，从盘符或者 / 开始；git 地址要带上 \`git@\`、\`https://\` 这类前缀。`,
      );
    }

    // 本机路径先自己看一眼。让 git 去撞，它只会回一句「不像个仓库」，分不出是路径
    // 敲错了还是这个目录压根没 git 过——而这两件事要做的补救完全不同。
    if (local) {
      let dir: Awaited<ReturnType<typeof stat>>;
      try {
        dir = await stat(source);
      } catch {
        return bad("路径不存在", `这台机器上找不到 \`${source}\`，看看是不是敲错了。`);
      }
      if (!dir.isDirectory()) {
        return bad("路径不是目录", `\`${source}\` 是个文件，仓库要指到目录。`);
      }
      if (!(await this.isRepo(source))) {
        return bad(
          "这个目录不是 git 仓库",
          `\`${source}\` 里没有 .git——先在里面 \`git init\` 并提交一次，或者换一个仓库。`,
        );
      }
    }

    const res = await this.git(["ls-remote", "--heads", "--", source], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (res.code !== 0) {
      return bad(
        "这个仓库连不上",
        local
          ? "本地仓库读不出来，看下这个目录是不是坏了。"
          : "地址对不对？这台机器有没有权限？",
        res.stderr.trim() || "git 没说原因",
      );
    }

    return { ok: true };
  }

  /**
   * 把工作区准备好，返回目录的绝对路径。
   *
   * 幂等：已经 clone 过就直接用，没有才现拉。所以每个要动代码的角色开工前都该叫
   * 一次，而不是假定「立项那会儿已经拉好了」——任务是落盘的，轮到这一棒时它可能
   * 已经在另一台机器上，或者目录被清掉了。
   *
   * 但要清楚重新 clone 出来的是干净的树：上一棒没提交的改动跟着原来那份工作区一起
   * 没了。研发那一棒的改动目前只留在工作区里（prompt 里明确不许 commit），所以真
   * 要跨机器接力，得先让它把改动提交推上去，这里才捞得回来。
   */
  async ensure(task: Session): Promise<string> {
    const repo = task.repo;
    if (!repo) {
      throw new WorkspaceError(`任务 ${task.id} 还没定仓库，没法准备工作区`);
    }

    // 顺手把过期的收拾掉。开工前反正要动盘，这时候扫一遍最省事——不然临时目录里
    // 那些聊崩了、收了工的仓库没人管，只会一直堆着。
    await this.sweep();

    const dir = this.dirOf(repo);
    if (!(await this.isRepo(dir))) {
      // 上次拉到一半死掉留下的半个目录，留着只会让 clone 报「目录非空」
      await rm(dir, { recursive: true, force: true });
      await this.clone(repo, dir);
    }
    await this.touch(dir);
    return dir;
  }

  private async isRepo(dir: string): Promise<boolean> {
    try {
      return (await stat(resolve(dir, ".git"))).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * 清掉闲了太久的工作区。
   *
   * 清不掉不算错——别的进程正在用、盘上文件锁着，都可能让 rm 失败。工作区丢了能重拉，
   * 为了扫不干净把开工这件事拦下来不值当。
   */
  private async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(ROOT);
    } catch {
      return;
    }

    const now = Date.now();
    for (const name of names) {
      const dir = resolve(ROOT, name);
      const usedAt = await this.lastUsedAt(dir);
      // 读不出日子的当它还活着。多留一个目录，比误删一个正在干活的工作区强得多
      if (usedAt === null || now - usedAt < IDLE_TTL_MS) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** 盖一下「刚用过」的戳。clone 完 `.git/` 一定在，写不进去也不用管——大不了下次被当成老的清掉重拉 */
  private async touch(dir: string): Promise<void> {
    await writeFile(
      resolve(dir, ".git", STAMP_FILE),
      `${new Date().toISOString()}\n`,
      "utf8",
    ).catch(() => {});
  }

  /** 上次开工是什么时候。没有戳记的（拉到一半死掉的半个目录）退回看目录自己的 mtime */
  private async lastUsedAt(dir: string): Promise<number | null> {
    for (const path of [resolve(dir, ".git", STAMP_FILE), dir]) {
      try {
        return (await stat(path)).mtimeMs;
      } catch {
        // 换下一个来源
      }
    }
    return null;
  }

  /** 拉仓库的默认分支。要哪条分支不用问——拉下来就是它自己的默认分支 */
  private async clone(repo: TaskRepo, dir: string): Promise<void> {
    const res = await this.git(["clone", "--", repo.source, dir], {
      timeoutMs: CLONE_TIMEOUT_MS,
    });
    if (res.code !== 0) {
      throw new WorkspaceError(`clone ${repo.source} 失败：\n${res.stderr.trim()}`);
    }
  }

  private git(
    args: string[],
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<GitResult> {
    const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

    return new Promise((done, fail) => {
      const child = spawn("git", args, {
        cwd: opts.cwd ?? process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        // 拉私有库时别弹密码框、别在这儿等着输密码——没配好凭证就当场失败
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (err: Error | null, code?: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) fail(err);
        else done({ code: code ?? null, stdout, stderr });
      };

      const timer = setTimeout(() => {
        child.kill();
        finish(new WorkspaceError(`git ${args[0] ?? ""} 超时（${timeoutMs / 1000}s）`));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        finish(
          new WorkspaceError(
            err.code === "ENOENT"
              ? "找不到 git，确认它装好了并且在 PATH 里"
              : `启动 git 失败：${err.message}`,
          ),
        );
      });
      child.on("close", (code) => {
        finish(null, code);
      });
    });
  }
}

export const workspace = new Workspace();
