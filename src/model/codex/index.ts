import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import type { CallRecorder } from "../../trace/call-recorder.js";
import { tracer } from "../../trace/index.js";
import { Model, ModelError, type GenerateOptions } from "../base.js";

/**
 * `codex exec`，走本机 Codex CLI 的登录态。
 *
 * 和 claude 那条的三处结构性差异，都在这个类里消化掉：
 *   1. 没有独立的 system prompt 参数 → system 拼在 user 前面一起走 stdin
 *   2. 结构化输出靠 --output-schema 读一个 JSON Schema 文件，不能内联传
 *   3. 最终答案不从 stdout 捞，用 --output-last-message 写到文件里再读
 *      （stdout 的事件流格式各版本改过好几轮，文件这条稳定得多）
 *
 * 跑在一个临时目录里 + --sandbox read-only，避免把本仓库的 AGENTS.md / git
 * 状态带进上下文，也避免它动文件。
 */
export class CodexModel extends Model {
  readonly name = "codex";

  private cli: string | null = null;

  async generate<T extends z.ZodType>(
    opts: GenerateOptions<T>,
  ): Promise<z.infer<T>> {
    // format 给 none：`codex exec` 默认吐的是给人看的文本，没有结构化事件，
    // 工具调用无从抽起。所以 codex 这一棒的现场只有耗时、排队、成败和原始
    // stdout——工具链会如实显示成空的，不是没记，是拿不到。要补就得在下面
    // args 里加 `--json`，再照它的事件格式写一个 parser（见 trace/parse.ts）
    const call = tracer.begin({
      ctx: opts.trace,
      provider: this.name,
      model: this.spec.model,
      effort: this.spec.effort,
      repo: opts.repo ?? null,
      format: "none",
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
    const dir = await mkdtemp(join(tmpdir(), "agent-team-codex-"));
    const schemaFile = join(dir, "schema.json");
    const outFile = join(dir, "last-message.txt");

    try {
      await writeFile(
        schemaFile,
        JSON.stringify(this.strictify(this.toJsonSchema(opts.schema))),
        "utf8",
      );

      const { stdout, stderr, code } = await this.run({
        call,
        bin: this.bin(),
        // 要看/要动代码就在目标仓库里跑；纯生成留在临时目录，碰不到任何仓库
        cwd: opts.repo?.path ?? dir,
        stdin: `${opts.system}\n\n---\n\n${opts.user}`,
        signal: opts.signal,
        // 只有开着工具跑的才排队；纯生成几秒就完，不占重活的位置
        gate: opts.repo ? (opts.repo.write ? "coding" : "reading") : null,
        onQueued: opts.onProgress && ((waiting) => {
          opts.onProgress?.({
            kind: "queued",
            text: waiting ? "前面还有任务在跑，轮到就开始" : "",
          });
        }),
        args: [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          // 沙箱是真的，操作系统层面拦：workspace-write 只放开 cwd，read-only
          // 让它跑得了 git diff 但一个字节都落不了盘
          opts.repo?.write ? "workspace-write" : "read-only",
          "--color",
          "never",
          "--model",
          this.spec.model,
          "-c",
          `model_reasoning_effort="${this.spec.effort}"`,
          "--output-schema",
          schemaFile,
          "--output-last-message",
          outFile,
          // "-" = prompt 从 stdin 读
          "-",
        ],
      });

      const answer = await readFile(outFile, "utf8").catch(() => null);
      if (answer === null) {
        throw new ModelError(
          `codex 退出（code=${code}）但没有写出结果。${this.hint(stderr)}${
            stderr.trim().slice(0, 500) || stdout.trim().slice(-500)
          }`,
        );
      }

      return this.validate(opts.schema, this.parseJson(answer));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private bin(): string {
    return (this.cli ??= this.resolveCli("codex", [
      join(
        process.env.APPDATA ?? "",
        "npm/node_modules/@openai/codex/bin/codex.exe",
      ),
      join(homedir(), ".codex/bin/codex.exe"),
      join(homedir(), ".cargo/bin/codex.exe"),
    ]));
  }

  /**
   * 上了 --output-schema 就该是纯 JSON，但模型偶尔仍会套一层 ``` 围栏，剥掉。
   */
  private parseJson(raw: string): unknown {
    let text = raw.trim();
    const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
    if (fence?.[1]) text = fence[1].trim();

    try {
      return JSON.parse(text);
    } catch {
      throw new ModelError(`codex 返回的不是合法 JSON：${text.slice(0, 300)}`);
    }
  }

  /**
   * OpenAI 的严格结构化输出要求每个对象都显式关掉额外字段、且所有属性都在
   * required 里。zod 转出来的 JSON Schema 不带这两条，这里递归补上。
   */
  private strictify(node: unknown): unknown {
    if (Array.isArray(node)) return node.map((item) => this.strictify(item));
    if (node === null || typeof node !== "object") return node;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = this.strictify(value);
    }

    if (out["type"] === "object") {
      out["additionalProperties"] = false;
      const props = out["properties"];
      if (props && typeof props === "object") {
        out["required"] = Object.keys(props);
      }
    }
    return out;
  }

  /** --output-schema 是较新版本才有的，装的是老版本时报错会很难懂 */
  private hint(stderr: string): string {
    return /unexpected argument|unrecognized|unknown option/i.test(stderr)
      ? "（看着像 codex 版本太老不认某个参数，先跑 `codex exec --help` 对一下）"
      : "";
  }
}
