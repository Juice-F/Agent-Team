import { postgres } from "../postgres/index.js";
import { dur, histogram, pad, tokens, usd } from "./format.js";

/** 表里一行。字段名和 trace/utils.ts 里那份 DDL 一一对应 */
interface SpanRow {
  call_id: string;
  instance_id: string;
  task_id: string;
  stage: string;
  job: string;
  provider: string;
  model: string;
  effort: string;
  repo_path: string | null;
  repo_write: boolean | null;
  started_at: Date;
  queued_ms: number;
  run_ms: number;
  ok: boolean;
  error: string | null;
  in_tokens: number;
  out_tokens: number;
  cache_read: number;
  cost_usd: number;
  turns: number;
  tool_count: number;
  tools: Record<string, number>;
  raw_key: string | null;
}

/**
 * 一个任务的完整调用链。
 *
 * 按 started_at 排，但**跨实例的时钟不可信**，所以这个顺序只当展示用；真要认
 * 因果顺序得看 Session.stageRecord 里的 from→to。同一个 stage 出现多行是正常的
 * ——打回重来就会再跑一次。
 */
export async function renderTask(query: string): Promise<string> {
  const rows = await find(query);
  if (typeof rows === "string") return rows;

  const taskId = rows[0]!.task_id;
  const out = [taskId, "", head(), ...rows.map(line)];

  out.push("", total(rows));

  const instances = new Set(rows.map((r) => r.instance_id));
  if (instances.size > 1) {
    // 跨机跑的任务，上面那个时间顺序更不能当因果看
    out.push(`  跑在 ${instances.size} 个实例上：${[...instances].join(" ")}`);
  }
  return out.join("\n");
}

/**
 * 先精确匹配，找不到再按包含找一遍。
 *
 * taskId 长这样：`Task-20260817-1609-3210`、`inbox-om9f8e...`——没人会完整敲一遍，
 * 通常是从日志里瞄到一截。匹配到多个就把候选列出来，别自作主张挑一个。
 */
async function find(query: string): Promise<SpanRow[] | string> {
  const exact = await rowsOf(`task_id = $1`, query);
  if (exact.length > 0) return exact;

  const like = await postgres.rows<{ task_id: string; n: number; at: Date }>(
    `select task_id, count(*)::int as n, min(started_at) as at
       from trace_calls where task_id like $1
      group by task_id order by min(started_at) desc limit 10`,
    [`%${query}%`],
  );

  if (like.length === 0) return `没有匹配 ${query} 的任务`;
  if (like.length === 1) return rowsOf(`task_id = $1`, like[0]!.task_id);

  return [
    `匹配到 ${like.length} 个任务，说清楚是哪个：`,
    ...like.map((r) => `  ${pad(r.task_id, 26)} ${r.n} 次调用  ${stamp(r.at)}`),
  ].join("\n");
}

function rowsOf(where: string, param: string): Promise<SpanRow[]> {
  return postgres.rows<SpanRow>(
    `select * from trace_calls where ${where} order by started_at`,
    [param],
  );
}

function head(): string {
  return (
    "  " +
    [
      pad("阶段", 12),
      pad("角色", 12),
      pad("模型", 26),
      pad("状态", 6),
      pad("排队", 9),
      pad("跑", 9),
      pad("token 入/出", 15),
      "花费",
    ].join(" ")
  );
}

function line(row: SpanRow): string {
  const main =
    "  " +
    [
      pad(row.stage, 12),
      pad(row.job, 12),
      pad(`${row.provider}/${row.model}`, 26),
      pad(row.ok ? "ok" : "FAIL", 6),
      pad(row.queued_ms > 0 ? dur(row.queued_ms) : "", 9),
      pad(dur(row.run_ms), 9),
      pad(`${tokens(row.in_tokens)}/${tokens(row.out_tokens)}`, 15),
      usd(row.cost_usd),
    ].join(" ");

  const extra: string[] = [];
  if (row.tool_count > 0) extra.push(`    ${histogram(row.tools)}`);
  // 失败原因要显眼——翻这份东西多半就是为了找它
  if (!row.ok && row.error) extra.push(`    ✗ ${row.error.split("\n")[0]}`);
  // 带上 key，下一步想看这一棒的完整现场时直接拿去捞
  if (row.raw_key) extra.push(`    ${row.raw_key}`);

  return [main, ...extra].join("\n");
}

function total(rows: SpanRow[]): string {
  const sum = (pick: (r: SpanRow) => number) => rows.reduce((a, r) => a + pick(r), 0);
  const fails = rows.filter((r) => !r.ok).length;
  const queued = sum((r) => r.queued_ms);

  return (
    `  合计 ${rows.length} 次调用` +
    `  跑 ${dur(sum((r) => r.run_ms))}` +
    (queued > 0 ? `  排队 ${dur(queued)}` : "") +
    `  ${tokens(sum((r) => r.in_tokens))}/${tokens(sum((r) => r.out_tokens))} token` +
    `  缓存命中 ${tokens(sum((r) => r.cache_read))}` +
    `  ${usd(sum((r) => r.cost_usd))}` +
    (fails > 0 ? `  ${fails} 次失败` : "")
  );
}

function stamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
}
