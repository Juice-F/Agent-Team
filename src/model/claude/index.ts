import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import type { CallRecorder } from "../../trace/call-recorder.js";
import { tracer } from "../../trace/index.js";
import {
  Model,
  ModelError,
  type GenerateOptions,
  type OnProgress,
} from "../base.js";

/**
 * `claude -p`，走本机 Claude Code 的订阅登录，不需要 API key。
 *
 * 五个关键参数：
 *   --json-schema   CLI 会注入一个 StructuredOutput 工具，最终事件里带回
 *                   已解析好的 structured_output，等价于 API 的结构化输出
 *   --system-prompt 替换（而非追加）Claude Code 的默认系统提示，省掉约 9000
 *                   token 的固定开销
 *   --tools ""      关掉所有内置工具，纯生成，不碰文件和命令
 *   --verbose       stream-json 必须配它，否则 CLI 直接报错退出
 *   --include-partial-messages 让 CLI 透传原始 SSE 事件，进度就从这里挑
 */

/** stream-json 的最终事件，答案在这一条里 */
interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  api_error_status?: string | null;
}

/**
 * --include-partial-messages 打开后透传的原始 SSE 事件，进度就从这里挑。
 * 只声明用得上的分支，其余形状忽略。
 */
interface PartialEvent {
  type?: "stream_event";
  event?: {
    type?: string;
    content_block?: { type?: string; name?: string };
    delta?: { type?: string; thinking?: string; text?: string };
  };
}

/** CLI 为了做结构化输出注进来的工具，不是模型在干活，别当进度报出去 */
const SCHEMA_TOOL = "StructuredOutput";

export class ClaudeModel extends Model {
  readonly name = "claude";

  private cli: string | null = null;

  async generate<T extends z.ZodType>(
    opts: GenerateOptions<T>,
  ): Promise<z.infer<T>> {
    const call = tracer.begin({
      ctx: opts.trace,
      provider: this.name,
      model: this.spec.model,
      effort: this.spec.effort,
      repo: opts.repo ?? null,
      format: "claude-stream-json",
    });
    try {
      const result = await this.attempt(opts, call);
      call?.ok();
      return result;
    } catch (err) {
      // CLI 退出码是 0 不代表这次成了——输出对不上 schema 照样是失败，
      // 所以成败得在这儿定，不能在 run() 那一层定
      call?.fail(err);
      throw err;
    } finally {
      // 不 await：压缩加落盘几百毫秒，没道理让它拖长这一棒。退出前 tracer.drain()
      if (call) tracer.track(call.flush());
    }
  }

  private async attempt<T extends z.ZodType>(
    opts: GenerateOptions<T>,
    call: CallRecorder | null,
  ): Promise<z.infer<T>> {
    const repo = opts.repo;
    const { stdout, stderr, code } = await this.run({
      call,
      bin: this.bin(),
      // 纯生成放在临时目录跑，避免把本仓库的 CLAUDE.md / git 状态带进上下文；
      // 要动代码就得在目标仓库里跑，那份上下文反过来正是要的
      cwd: repo?.path ?? tmpdir(),
      stdin: opts.user,
      signal: opts.signal,
      // 只有开着工具跑的才排队。写代码那一棒单独一个闸门——它最贵、跑最久，
      // 和只读那几棒共用的话会把它们全饿死
      gate: repo ? (repo.write ? "coding" : "reading") : null,
      onQueued: opts.onProgress && ((waiting) => {
        opts.onProgress?.({
          kind: "queued",
          text: waiting ? "前面还有任务在跑，轮到就开始" : "",
        });
      }),
      onLine: opts.onProgress && ((line) => this.report(line, opts.onProgress!)),
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        ...(repo
          ? this.workingArgs(opts.system, repo.write)
          : this.pureArgs(opts.system)),
        "--json-schema",
        JSON.stringify(this.toJsonSchema(opts.schema)),
        "--model",
        this.spec.model,
        "--effort",
        this.spec.effort,
        "--no-session-persistence",
      ],
    });

    const result = this.lastResultEvent(stdout);
    if (!result) {
      throw new ModelError(
        `claude 退出（code=${code}）但没有返回结果。${stderr.trim().slice(0, 500)}`,
      );
    }
    if (result.is_error || result.subtype !== "success") {
      throw new ModelError(
        `claude 调用失败（${result.subtype ?? "unknown"}${
          result.api_error_status ? ` / ${result.api_error_status}` : ""
        }）：${result.result ?? "无输出"}`,
      );
    }

    return this.validate(opts.schema, this.payloadOf(result));
  }

  /**
   * 纯生成：整个换掉默认系统提示，省掉约 9000 token 的固定开销；工具全关。
   */
  private pureArgs(system: string): string[] {
    return ["--system-prompt", system, "--tools", ""];
  }

  /**
   * 在仓库里干活。
   *
   * 系统提示只能追加不能替换——换掉的话 Claude Code 自带的那套工具使用规则也
   * 一起没了，它就不知道该怎么读文件、怎么改。
   *
   * bypassPermissions 是必须的：headless 下没人能点确认，不放开的话工具调用会
   * 被直接拒掉，模型只会干看着。代价是它在这个仓库里可以任意读写和执行命令
   * ——这条路本来就是「让 AI 自己改代码」，风险在需求里，不在这行参数里。
   *
   * 只读那档要留神：靠的是不给 Edit / Write 这几个工具，但 Bash 还在（不给的话
   * 连 git diff 都跑不了），所以它是约定不是强制，一条 shell 命令照样能落盘。
   * 真要拦住得靠 codex 那边的 read-only sandbox，那个是操作系统层面的。
   */
  private workingArgs(system: string, write: boolean): string[] {
    return [
      "--append-system-prompt",
      system,
      "--tools",
      write ? "default" : "Read,Grep,Glob,Bash",
      "--permission-mode",
      "bypassPermissions",
    ];
  }

  private bin(): string {
    return (this.cli ??= this.resolveCli("claude", [
      join(
        process.env.APPDATA ?? "",
        "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      ),
      join(homedir(), ".local/bin/claude.exe"),
      join(
        process.env.ProgramFiles ?? "",
        "nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      ),
    ]));
  }

  /**
   * 把一行原始事件翻成进度。看不懂的行直接丢，不报错——进度是锦上添花，
   * 不能因为 CLI 换了事件格式就把整次调用弄挂。
   */
  private report(line: string, onProgress: OnProgress): void {
    let parsed: PartialEvent;
    try {
      parsed = JSON.parse(line) as PartialEvent;
    } catch {
      return;
    }
    if (parsed.type !== "stream_event") return;

    const event = parsed.event;
    if (event?.type === "content_block_delta") {
      const { thinking, text } = event.delta ?? {};
      if (thinking) onProgress({ kind: "thinking", text: thinking });
      else if (text) onProgress({ kind: "text", text });
      return;
    }
    if (event?.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "tool_use" && block.name && block.name !== SCHEMA_TOOL) {
        onProgress({ kind: "tool", text: block.name });
      }
    }
  }

  /** JSONL：逐行解析，非 JSON 行忽略，取最后一条 result */
  private lastResultEvent(stdout: string): ResultEvent | null {
    let last: ResultEvent | null = null;
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as { type?: string };
        if (event.type === "result") last = event as ResultEvent;
      } catch {
        // 非 JSON 行忽略
      }
    }
    return last;
  }

  /** 正常情况下 structured_output 就是解析好的对象；兜底再解析一次 result 字符串 */
  private payloadOf(result: ResultEvent): unknown {
    if (result.structured_output !== undefined && result.structured_output !== null) {
      return result.structured_output;
    }
    if (!result.result) throw new ModelError("claude 没有返回结构化结果");
    try {
      return JSON.parse(result.result);
    } catch {
      throw new ModelError(
        `claude 返回的不是合法 JSON：${result.result.slice(0, 300)}`,
      );
    }
  }
}
