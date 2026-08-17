import { postgres } from "../postgres/index.js";

/**
 * 汇总表
 *
 * 和对象存储的分工：那边一次调用一个对象，装完整现场，写多读极少，只在「这一棒
 * 做砸了」时整份捞；这边一次调用一行，要能扫、能按时间聚合——哪一棒慢、哪个模型
 * 贵、谁在反复失败，都得靠 SQL 问出来。两边靠 raw_key 这一列连起来。
 *
 * 全部用 integer / double precision，一个 bigint 和 numeric 都没有。不是随便选的：
 * node-pg 会把 bigint 和 numeric 当成**字符串**返回（怕丢精度），于是
 * `row.in_tokens + 1` 会变成字符串拼接，而且不报错。计数最大也就千万级，integer
 * 装得下；钱是拿来看趋势的，不做对账，float8 够。
 */
const DDL = `
create table if not exists trace_calls (
  call_id      uuid primary key,
  instance_id  text        not null,
  task_id      text        not null,
  stage        text        not null,
  job          text        not null,
  provider     text        not null,
  model        text        not null,
  effort       text        not null,
  repo_path    text,
  repo_write   boolean,
  started_at   timestamptz not null,
  queued_ms    integer     not null,
  run_ms       integer     not null,
  ok           boolean     not null,
  error        text,
  in_tokens    integer     not null default 0,
  out_tokens   integer     not null default 0,
  cache_read   integer     not null default 0,
  cache_write  integer     not null default 0,
  cost_usd     double precision not null default 0,
  turns        integer     not null default 0,
  tool_count   integer     not null default 0,
  tools        jsonb       not null default '{}'::jsonb,
  raw_key      text,
  raw_bytes    integer     not null default 0
);
create index if not exists trace_calls_task_idx on trace_calls (task_id, started_at);
create index if not exists trace_calls_time_idx on trace_calls (started_at desc);
`;

export async function initSpanTable(): Promise<void> {
  await postgres.exec(DDL).catch((err: unknown) => {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== "23505") throw err;
  });
}
