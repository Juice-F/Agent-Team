import { traceConfig } from "../config.js";
import type { StreamFormat, ToolCall, Usage } from "./type.js";

/**
 * CLI 为了做结构化输出注进来的工具，不是模型在干活。
 * 和 model/claude 那边报进度时的口径保持一致：不算进工具链。
 */
const SCHEMA_TOOL = "StructuredOutput";

export interface StreamParser {
  /** @param at 这一行到达的时刻。事件流自己不带时间戳，工具耗时全靠它 */
  line(raw: string, at: number): void;
  readonly tools: ToolCall[];
  readonly usage: Usage | null;
}

export function truncate(text: string, max: number = traceConfig.fieldMax): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…（截断，原长 ${text.length}）`;
}

/**
 * 工具在报表里显示成什么。
 *
 * 光看 name 的话，skill 调用全都叫「Skill」、子 agent 全都叫「Task」，
 * 直方图出来是一片没有信息量的计数。把关键参数并进标签，
 * 「这一棒用了哪个 skill」才看得出来。
 */
function labelOf(name: string, input: Record<string, unknown>): string {
  if (name === "Skill" && typeof input["skill"] === "string") {
    return `Skill:${input["skill"]}`;
  }
  if (
    (name === "Task" || name === "Agent") &&
    typeof input["subagent_type"] === "string"
  ) {
    return `Agent:${input["subagent_type"]}`;
  }
  return name;
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface StreamLine {
  type?: string;
  message?: { content?: ContentBlock[] };
  usage?: Record<string, unknown>;
  total_cost_usd?: number;
  num_turns?: number;
}

/** tool_result 的 content 可能是字符串，也可能是一组块。都拍平成文本 */
function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const text = (block as { text?: unknown } | null)?.text;
        return typeof text === "string" ? text : JSON.stringify(block);
      })
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

function int(source: Record<string, unknown> | undefined, key: string): number {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 解析 `claude -p --output-format stream-json` 的事件流。
 *
 * 只认 assistant / user / result 这三种**完整消息**事件，不碰 stream_event。
 * 原因：`--include-partial-messages` 透传的是原始 SSE，工具参数是
 * input_json_delta 一片片流出来的，要自己拼；而完整的 assistant 消息里
 * `input` 本来就是解析好的对象，直接拿。进度那条链需要增量（要边跑边刷卡片），
 * 追踪不需要——它只在调用结束时落一次。
 *
 * 认不出来的行一律忽略：CLI 换了事件格式最多让链路变空，不能把整次调用弄挂。
 */
export class ClaudeStreamParser implements StreamParser {
  readonly tools: ToolCall[] = [];
  usage: Usage | null = null;

  /** tool_use_id → 那条记录，等 tool_result 回来时补上结果 */
  private readonly waiting = new Map<string, { call: ToolCall; at: number }>();

  constructor(private readonly startedAtMs: number) {}

  line(raw: string, at: number): void {
    let event: StreamLine;
    try {
      event = JSON.parse(raw) as StreamLine;
    } catch {
      return;
    }

    if (event.type === "assistant") this.onAssistant(event, at);
    else if (event.type === "user") this.onUser(event, at);
    else if (event.type === "result") this.onResult(event);
  }

  private onAssistant(event: StreamLine, at: number): void {
    for (const block of event.message?.content ?? []) {
      if (block.type !== "tool_use" || !block.name) continue;
      if (block.name === SCHEMA_TOOL) continue;

      const input = (block.input ?? {}) as Record<string, unknown>;
      const call: ToolCall = {
        id: block.id ?? `${block.name}-${this.tools.length}`,
        name: labelOf(block.name, input),
        input: truncate(JSON.stringify(input)),
        atMs: at - this.startedAtMs,
      };
      this.tools.push(call);
      this.waiting.set(call.id, { call, at });
    }
  }

  private onUser(event: StreamLine, at: number): void {
    for (const block of event.message?.content ?? []) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const pending = this.waiting.get(block.tool_use_id);
      if (!pending) continue;

      pending.call.output = truncate(flatten(block.content));
      pending.call.ok = block.is_error !== true;
      pending.call.ms = at - pending.at;
      this.waiting.delete(block.tool_use_id);
    }
  }

  private onResult(event: StreamLine): void {
    // 最后一条 result 是权威的总账，后来的盖掉先来的
    this.usage = {
      input: int(event.usage, "input_tokens"),
      output: int(event.usage, "output_tokens"),
      cacheRead: int(event.usage, "cache_read_input_tokens"),
      cacheWrite: int(event.usage, "cache_creation_input_tokens"),
      costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0,
      turns: typeof event.num_turns === "number" ? event.num_turns : 0,
    };
  }
}

/**
 * 什么都不解析。
 *
 * codex 那条链现在就是这个：`codex exec` 默认吐的是给人看的文本，没有结构化
 * 事件，工具调用无从抽起。要补的话得在 codex/index.ts 的 args 里加 `--json`，
 * 然后照着它的事件格式再写一个 parser——在那之前，codex 的调用只有耗时、
 * 排队、成败这几项，工具链会如实显示成空的，不是没记，是拿不到。
 */
export class NullParser implements StreamParser {
  readonly tools: ToolCall[] = [];
  readonly usage: Usage | null = null;
  line(): void {}
}

export function parserFor(format: StreamFormat, startedAtMs: number): StreamParser {
  return format === "claude-stream-json"
    ? new ClaudeStreamParser(startedAtMs)
    : new NullParser();
}
