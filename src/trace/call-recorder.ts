import { randomUUID } from "node:crypto";
import { traceConfig } from "../config.js";
import { parserFor, truncate, type StreamParser } from "./parse.js";
import type { CallSpan, SpanSeed, TraceContext } from "./type.js";
import { instanceId, rawKey, writeRaw } from "./utils.js";

export class CallRecorder {
  private readonly callId = randomUUID();
  private readonly beganAtMs = Date.now();
  private readonly startedAt = new Date().toISOString();
  private readonly parser: StreamParser;

  private runFromMs: number | null = null;
  private endedAtMs: number | null = null;
  private outcome: { ok: boolean; error: string | null } | null = null;
  private stdout = "";
  private stderr = "";
  private flushed = false;

  constructor(
    private readonly seed: SpanSeed,
    private readonly ctx: TraceContext,
  ) {
    this.parser = parserFor(seed.format, Date.now());
  }

  /** 抢到闸门槽位、真正开跑的那一刻。在这之前算排队 */
  started(): void {
    this.runFromMs ??= Date.now();
  }

  /** 喂一行 CLI stdout */
  line(raw: string): void {
    // 解析出的异常绝不能冒到调用方——那条路上跑着的是真活
    try {
      this.parser.line(raw, Date.now());
    } catch {
      // 认不出来就算了，链路缺一段总比把一棒弄挂强
    }
  }

  ok(): void {
    this.settle({ ok: true, error: null });
  }

  fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.settle({ ok: false, error: truncate(message, 1000) });
  }

  /** 把 CLI 的原始输出交进来。超时、被中断时也要交——那才是最该留的现场 */
  attach(stdout: string, stderr: string): void {
    this.stdout = stdout;
    this.stderr = stderr;
  }

  /** 落盘。幂等，重复调只写一次 */
  async flush(): Promise<void> {
    if (this.flushed) return;
    this.flushed = true;

    const span = this.toSpan();
    const { stdout, truncated } = this.clampRaw();
    try {
      await writeRaw({
        span,
        tools: this.parser.tools,
        stdout,
        stderrTail: this.stderr.slice(-traceConfig.stderrTail),
        truncated,
      });
    } catch (err) {
      // 写不进去只能是日志。跟 gate.ts 那句「Redis 挂了就放行」同一个取舍：
      // 观测手段绝不能变成主流程的故障点
      console.error(`[trace] ${span.taskId}/${span.stage} 落盘失败`, err);
    }
  }

  /** 超长的原始流留首尾：出问题的现场要么在开头（参数不对），要么在结尾（崩在哪） */
  private clampRaw(): { stdout: string; truncated: boolean } {
    const max = traceConfig.rawMax;
    const raw = this.stdout;
    if (raw.length <= max) return { stdout: raw, truncated: false };

    const half = Math.floor(max / 2);
    return {
      stdout:
        `${raw.slice(0, half)}
` +
        `…（中间截掉 ${raw.length - max} 字）
` +
        `${raw.slice(-half)}`,
      truncated: true,
    };
  }

  private settle(outcome: { ok: boolean; error: string | null }): void {
    this.outcome ??= outcome;
    this.endedAtMs ??= Date.now();
  }

  private toSpan(): CallSpan {
    const endedAtMs = this.endedAtMs ?? Date.now();
    const runFromMs = this.runFromMs ?? this.beganAtMs;
    const tools = this.parser.tools;

    const toolHistogram: Record<string, number> = {};
    for (const tool of tools) {
      toolHistogram[tool.name] = (toolHistogram[tool.name] ?? 0) + 1;
    }

    return {
      callId: this.callId,
      instanceId,
      taskId: this.ctx.taskId,
      stage: this.ctx.stage,
      job: this.ctx.job,
      provider: this.seed.provider,
      model: this.seed.model,
      effort: this.seed.effort,
      repoPath: this.seed.repo?.path ?? null,
      repoWrite: this.seed.repo ? this.seed.repo.write : null,
      startedAt: this.startedAt,
      queuedMs: runFromMs - this.beganAtMs,
      runMs: endedAtMs - runFromMs,
      ok: this.outcome?.ok ?? false,
      error: this.outcome
        ? this.outcome.error
        : "这次调用没有收尾（记录器漏了 ok/fail）",
      usage: this.parser.usage,
      toolCount: tools.length,
      toolHistogram,
      rawKey: rawKey(this.ctx.taskId, this.ctx.stage, this.callId),
      rawBytes: this.stdout.length,
    };
  }
}
