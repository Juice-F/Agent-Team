import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { AgentSpec } from "../types.js";

export class ModelError extends Error {}

export interface ModelProgress {
  kind: "thinking" | "text" | "tool";
  /** kind 为 tool 时是工具名，其余是模型写出来的话 */
  text: string;
}

export type OnProgress = (p: ModelProgress) => void;

export interface GenerateOptions<T extends z.ZodType> {
  system: string;
  user: string;
  schema: T;
  /**
   * 在哪个仓库里干活。
   *
   * 不给就是纯生成：关掉所有工具、跑在临时目录，碰不到任何仓库——判断、拆需求
   * 那几棒都是这样。给了就在这个目录里开着工具跑。
   *
   * write 决定它能不能动文件：写代码那一棒要 true，审查只是去看代码，给 false。
   * 写成一个对象是为了让「只读但没说在哪个仓库」这种半截状态压根写不出来。
   */
  repo?: { path: string; write: boolean };
  /** 不传就什么都不报，模型层不自己往控制台打 */
  onProgress?: OnProgress;
  /**
   * 中断信号，一路从流程那边带下来。
   *
   * abort 之后 CLI 子进程立刻被杀掉——一次调用能跑十几分钟，不真把进程干掉，
   * 「中断」就只是嘴上说说，模型还在那儿烧着额度。
   */
  signal?: AbortSignal;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export abstract class Model {
  abstract readonly name: string;

  constructor(readonly spec: AgentSpec) {}

  abstract generate<T extends z.ZodType>(
    opts: GenerateOptions<T>,
  ): Promise<z.infer<T>>;

  /** zod → JSON Schema。$schema 这个元字段两家 CLI 都不认，去掉。 */
  protected toJsonSchema(schema: z.ZodType): Record<string, unknown> {
    const json = z.toJSONSchema(schema, { io: "output" }) as Record<
      string,
      unknown
    >;
    delete json["$schema"];
    return json;
  }

  /** 最后一道闸：CLI 说成功不代表内容对得上 schema */
  protected validate<T extends z.ZodType>(
    schema: T,
    payload: unknown,
  ): z.infer<T> {
    const parsed = schema.safeParse(payload);
    if (parsed.success) return parsed.data;
    throw new ModelError(
      `${this.name} 输出不符合 schema：\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n")}`,
    );
  }

  protected resolveCli(bin: string, winCandidates: string[]): string {
    if (process.platform !== "win32") return bin;

    for (const candidate of winCandidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
    throw new ModelError(
      `找不到 ${bin}.exe，装在非默认位置的话把路径加进 ${bin} 那个类的候选列表。`,
    );
  }

  protected run(input: {
    bin: string;
    args: string[];
    stdin: string;
    cwd: string;
    onLine?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(input.bin, input.args, {
        cwd: input.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (err: Error | null, value?: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(value!);
      };

      const timer = setTimeout(() => {
        child.kill();
        finish(
          new ModelError(
            `${this.name} 调用超时（${this.spec.timeoutMs / 1000}s）`,
          ),
        );
      }, this.spec.timeoutMs);

      // 中断的理由由上游给（比如「进程退出」），原样抛出去，别包成超时之类的
      const onAbort = () => {
        child.kill();
        const reason: unknown = input.signal?.reason;
        finish(
          reason instanceof Error
            ? reason
            : new ModelError(`${this.name} 调用被中断`),
        );
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      // 进这个函数之前就已经 abort 了的话，事件不会再来一次
      if (input.signal?.aborted) onAbort();

      let pending = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!input.onLine) return;
        pending += chunk;
        let index: number;
        while ((index = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          // 进度回调抛异常不该弄挂整次调用
          if (line) {
            try {
              input.onLine(line);
            } catch (err) {
              console.error(`[${this.name}] onLine`, err);
            }
          }
        }
      });
      
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        finish(
          new ModelError(
            err.code === "ENOENT" || err.code === "EINVAL"
              ? `无法启动 ${input.bin}（${err.code}），确认它装好了并且在 PATH 里。`
              : `启动 ${input.bin} 失败：${err.message}`,
          ),
        );
      });

      child.on("close", (code) => {
        finish(null, { code, stdout, stderr });
      });

      child.stdin.end(input.stdin, "utf8");
    });
  }
}
