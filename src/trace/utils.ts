import { hostname } from "node:os";
import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import { oss } from "../oss/index.js";
import { postgres } from "../postgres/index.js";
import type { CallSpan, RawTrace } from "./type.js";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

export const instanceId = `${hostname()}-${process.pid}`;

/**
 * 完整现场在对象存储里的 key。
 *
 * 一次调用一个对象，不是一个任务一个——对象存储不支持 append，而同一个任务的
 * 几次调用可能落在不同实例上，共用一个 key 就是互相覆盖。callId 是 uuid，
 * 天然保证不撞。
 */
export function rawKey(taskId: string, stage: string, callId: string): string {
  return `trace/${taskId}/${stage}/${callId}.json.gz`;
}

export async function writeRaw(raw: RawTrace): Promise<number> {
  const body = await gzip(JSON.stringify(raw));
  await oss.put(raw.span.rawKey, body);
  return body.byteLength;
}

export async function readRaw(key: string): Promise<RawTrace | null> {
  const body = await oss.get(key);
  if (!body) return null;
  return JSON.parse((await gunzip(body)).toString("utf8")) as RawTrace;
}

/**
 * 落一次调用的汇总。
 *
 * rawKey 单独传而不直接用 span.rawKey：现场可能没写进去，那这一行的 raw_key
 * 就得记 null，别指向一个不存在的对象。
 *
 * on conflict do nothing：callId 是 uuid，正常不会撞，但重试路径上同一条 span
 * 可能被 flush 两次，撞上就当已经写过了。
 */
export async function writeSpan(
  span: CallSpan,
  rawKey: string | null,
): Promise<void> {
  await postgres.exec(
    `insert into trace_calls (
       call_id, instance_id, task_id, stage, job, provider, model, effort,
       repo_path, repo_write, started_at, queued_ms, run_ms, ok, error,
       in_tokens, out_tokens, cache_read, cache_write, cost_usd, turns,
       tool_count, tools, raw_key, raw_bytes
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
       $16,$17,$18,$19,$20,$21,$22,$23,$24,$25
     )
     on conflict (call_id) do nothing`,
    [
      span.callId,
      span.instanceId,
      span.taskId,
      span.stage,
      span.job,
      span.provider,
      span.model,
      span.effort,
      span.repoPath,
      span.repoWrite,
      span.startedAt,
      span.queuedMs,
      span.runMs,
      span.ok,
      span.error,
      span.usage?.input ?? 0,
      span.usage?.output ?? 0,
      span.usage?.cacheRead ?? 0,
      span.usage?.cacheWrite ?? 0,
      span.usage?.costUsd ?? 0,
      span.usage?.turns ?? 0,
      span.toolCount,
      JSON.stringify(span.toolHistogram),
      rawKey,
      span.rawBytes,
    ],
  );
}
