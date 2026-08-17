import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import { withGate, type GateKind } from "../redis/gate.js";
import type { CallRecorder } from "../trace/call-recorder.js";
import type { TraceContext } from "../trace/type.js";
import type { AgentSpec } from "../types.js";

export class ModelError extends Error {}

export interface ModelProgress {
  /**
   * queued 是「还没开跑，在排队等一个槽位」——见 redis/gate.ts。
   *
   * 和其余三种不是一类：那三种是模型正在吐东西，这个是「什么都没发生，但不是卡
   * 住了」。得让它显示成完全不同的样子，不然用户看到的就是一张停住不动的卡片。
   */
  kind: "thinking" | "text" | "tool" | "queued";
  /** kind 为 tool 时是工具名；queued 时是排队的说明，空串表示排到了 */
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
  /**
   * 这次调用替谁跑的，用来记链路。不给就不记。
   *
   * 不是可有可无的装饰：多实例下同一个任务的几棒散在不同机器上，没有它，
   * 日志里那些耗时和花费属于谁都对不上号。见 src/trace/。
   */
  trace?: TraceContext;
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

  /**
   * 起一个 CLI 子进程把活干完。
   *
   * `gate` 决定这次要不要先排队等一个槽位：开着工具跑的那几棒才算重活，纯生成
   * （立项判断、意图分类）几秒就完，闸它们只会让它们去抢本该留给重活的位置。
   *
   * 闸在这一层而不是外面，是因为超时得从**真正开跑**那一刻算起：`spec.timeoutMs`
   * 是给模型的，不是给排队的。等槽位的时间要是也算进去，高峰期一堆任务会在还没
   * 开跑的时候就被判超时。
   */
  protected async run(input: {
    bin: string;
    args: string[];
    stdin: string;
    cwd: string;
    onLine?: (line: string) => void;
    signal?: AbortSignal;
    /** 要占哪个闸门的槽位。纯生成传 null，不排队 */
    gate?: GateKind | null;
    /** 开始排队时给 true，抢到槽位开跑时给 false。用来让卡片说句话 */
    onQueued?: (waiting: boolean) => void;
    /**
     * 这次调用的记录器，由 generate() 开、也由它收尾。
     *
     * 这一层只做两件事：告诉它什么时候真正开跑（在这之前都算排队），
     * 以及把 CLI 的原始输出交给它——**包括超时和被中断那两条路**，
     * 那才是最该留下现场的时候。
     *
     * 链路没通、或者这次调用没带上下文时，tracer.begin() 给的就是 null。
     */
    call?: CallRecorder | null;
  }): Promise<RunResult> {
    // 出错时 launch 的 Promise 直接 reject，局部的 stdout 就跟着没了。
    // 交给外面这个盒子接着，超时/中断也能把已经吐出来的那半截留下来
    const capture = { stdout: "", stderr: "" };
    const onLine = input.call
      ? (line: string) => {
          input.call?.line(line);
          input.onLine?.(line);
        }
      : input.onLine;

    try {
      if (!input.gate) {
        input.call?.started();
        return await this.launch({ ...input, onLine, capture });
      }

      const gate = input.gate;
      return await withGate(
        gate,
        input.signal,
        () => {
          input.onQueued?.(false);
          // 抢到槽位这一刻才算开跑，前面等的那段单独记成 queuedMs
          input.call?.started();
          return this.launch({ ...input, onLine, capture });
        },
        () => {
          console.log(`[gate] ${this.name} 排队等 ${gate} 槽位`);
          input.onQueued?.(true);
        },
      );
    } finally {
      input.call?.attach(capture.stdout, capture.stderr);
    }
  }

  private launch(input: {
    bin: string;
    args: string[];
    stdin: string;
    cwd: string;
    onLine?: (line: string) => void;
    signal?: AbortSignal;
    capture?: { stdout: string; stderr: string };
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
        if (input.capture) input.capture.stdout = stdout;
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
        if (input.capture) input.capture.stderr = stderr;
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
