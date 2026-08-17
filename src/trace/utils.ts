import { hostname } from "node:os";
import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import { oss } from "../oss/index.js";
import type { RawTrace } from "./type.js";

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
