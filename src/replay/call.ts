import { postgres } from "../postgres/index.js";
import { readRaw } from "../trace/utils.js";
import { dur, pad, tokens, usd } from "./format.js";

/**
 * 一次调用内部的工具时间线，从对象存储把完整现场捞回来。
 *
 * 这是链路真正兑现的地方：`trace task` 只告诉你这一棒调了 9 次 Edit，这里才看得到
 * 它改的是哪 9 个文件、哪一次花了 5 分钟、哪一次报错了。
 */
export async function renderCall(query: string): Promise<string> {
  const key = await resolve(query);
  if (key === null) return `没有匹配 ${query} 的调用`;
  if (typeof key !== "string") return key.hint;

  let raw;
  try {
    raw = await readRaw(key);
  } catch (err) {
    return `${key} 读不出来：${err instanceof Error ? err.message : String(err)}`;
  }
  // 汇总行还在但对象没了：写现场那一步失败过，或者被清理规则收走了
  if (!raw) return `${key} 在对象存储里找不到（汇总行可能还在，用 trace task 看）`;

  const { span } = raw;
  const out = [
    `${span.taskId} / ${span.stage} / ${span.job}`,
    `  ${span.provider}/${span.model}  effort=${span.effort}  @ ${span.instanceId}`,
    `  ${span.startedAt}`,
    `  排队 ${dur(span.queuedMs)}  跑 ${dur(span.runMs)}  ${
      span.ok ? "ok" : `FAIL  ${span.error ?? ""}`
    }`,
    `  仓库 ${span.repoPath ?? "（纯生成，没碰仓库）"}${span.repoWrite ? "  可写" : ""}`,
  ];

  if (span.usage) {
    out.push(
      `  token 入 ${tokens(span.usage.input)} / 出 ${tokens(span.usage.output)}` +
        ` / 缓存命中 ${tokens(span.usage.cacheRead)}  ${usd(span.usage.costUsd)}` +
        `  ${span.usage.turns} 轮`,
    );
  }

  out.push("");
  if (raw.tools.length === 0) {
    out.push(
      span.provider === "codex"
        ? "  （codex 拿不到工具链，见 trace/parse.ts 的说明）"
        : "  （没有工具调用）",
    );
  } else {
    out.push(`  工具 ${raw.tools.length} 次：`);
    for (const tool of raw.tools) {
      // ms 为 undefined = 没等到结果：被中断、超时，或者 CLI 半路挂了
      const status = tool.ms === undefined ? "  …没等到结果" : tool.ok ? "" : "  ✗";
      out.push(
        `    ${pad("+" + dur(tool.atMs), 9)} ${pad(tool.name, 22)}` +
          `${pad(tool.ms === undefined ? "" : dur(tool.ms), 9)}${status}`,
      );
      out.push(`        ← ${oneLine(tool.input)}`);
      if (tool.output !== undefined) out.push(`        → ${oneLine(tool.output)}`);
    }
  }

  if (raw.truncated) {
    out.push("", `  （原始流过长，中间截掉了一段；截断前 ${span.rawBytes} 字）`);
  }
  if (raw.stderrTail.trim()) {
    out.push("", `  stderr 尾巴：${oneLine(raw.stderrTail, 400)}`);
  }
  return out.join("\n");
}

/**
 * 参数可以是完整 key，也可以是 callId 的一截。
 *
 * key 长这样：`trace/Task-…/coding/<uuid>.json.gz`——从 `trace task` 的输出里
 * 整行复制当然行，但更多时候手上只有一截 uuid。带斜杠就当 key 用，否则回 PG
 * 按 call_id 找。
 */
async function resolve(query: string): Promise<string | null | { hint: string }> {
  if (query.includes("/")) return query;

  const rows = await postgres.rows<{
    call_id: string;
    raw_key: string | null;
    task_id: string;
    stage: string;
    job: string;
  }>(
    `select call_id, raw_key, task_id, stage, job from trace_calls
      where call_id::text like $1 order by started_at desc limit 10`,
    [`%${query}%`],
  );

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    return {
      hint: [
        `匹配到 ${rows.length} 次调用，说清楚是哪次：`,
        ...rows.map((r) => `  ${r.call_id}  ${r.task_id} / ${r.stage} / ${r.job}`),
      ].join("\n"),
    };
  }

  const hit = rows[0]!;
  if (!hit.raw_key) {
    return { hint: `${hit.call_id} 有汇总但没留现场（写对象存储那步当时失败了）` };
  }
  return hit.raw_key;
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
