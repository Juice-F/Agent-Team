import { postgres } from "./index.js";

/**
 * 任务状态表
 *
 * 原来存在 Redis 里，搬过来是因为两件事对不上：这是**业务状态**，不能丢也不该
 * 自己过期，而 Redis 是内存库 + 7 天 TTL——一个停着等人确认的需求，放一周就
 * 蒸发了。Redis 那边只留它擅长的：闸门、话题锁、立项去重，那三样丢了最多重跑
 * 一次，本来就按「Redis 挂了就放行」设计的。
 *
 * 顺带拿到的：任务 id 和 trace_calls.task_id 在同一个库里，「哪个需求最烧钱」
 * 从跨两个存储手工拼变成一条 join。
 *
 * 常查的列化、复杂结构进 jsonb：turns 和 stageRecord 是按阶段分桶的嵌套结构，
 * 拆成表没意义——它们永远是整份读、整份写。
 */
const DDL = `
create table if not exists sessions (
  thread_id     text primary key,
  id            text        not null unique,
  chat_id       text        not null,
  root_msg_id   text        not null,
  title         text        not null default '',
  request       text        not null default '',
  settled       boolean     not null default false,
  repo_source   text,
  plan          text        not null default '',
  review_note   text        not null default '',
  accept_note   text        not null default '',
  stage         text        not null,
  phase         text        not null default 'pending',
  turns         jsonb       not null default '{}'::jsonb,
  stage_record  jsonb       not null default '{}'::jsonb,
  created_at    timestamptz not null,
  updated_at    timestamptz not null
);
create index if not exists sessions_active_idx on sessions (phase) where phase <> 'waiting';
`;

export async function initSessionTable(): Promise<void> {
  await postgres.exec(DDL).catch((err: unknown) => {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== "23505") throw err;
  });
}
