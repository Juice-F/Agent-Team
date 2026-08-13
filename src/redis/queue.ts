import { randomUUID } from "node:crypto";
import type { AgentJob, Inbound, WorkflowStage } from "../types.js";
import { NS, redis } from "./index.js";

/**
 * 锁的存活时间。
 *
 * 短是故意的：持锁的进程当场崩掉时，这个话题最多卡这么久就有人能接手。跑得久
 * 的那些棒不靠它撑，靠下面的续租——见 RENEW_MS。
 */
const LOCK_TTL_MS = 30_000;

/**
 * 多久续一次租。
 *
 * 取 TTL 的三分之一：一次续租失败（网络抖一下）还有两次机会，不至于让还在跑的
 * 那一棒把锁丢了。研发那一棒能跑一小时，全靠这个续下去。
 */
const RENEW_MS = 10_000;

function lockKey(threadId: string): string {
  return `${NS}:lock:${threadId}`;
}

function pendingKey(threadId: string): string {
  return `${NS}:pending:${threadId}`;
}

/**
 * 续租：先确认这把锁还是自己的，再往后延。
 *
 * 必须是一条 Lua：读和写之间要是能插进别人，续的就可能是别人的锁——自己的那把
 * 早过期了，另一个副本刚抢到，这一延就把人家的锁按住了。
 */
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

/**
 * 释放：同样要先认人。
 *
 * 不认人的 DEL 会删掉别人的锁：自己这边超时了、锁已经过期、另一个副本抢了进去，
 * 这时候自己干完活直接 DEL，删的是人家正拿着的那把。
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export interface Lease {
  /** 放开这个话题。停掉续租，并且只在锁确实还是自己的时候才删 */
  release(): Promise<void>;
}

/**
 * 抢这个话题。抢到给一张租约，没抢到给 null（说明别的地方正跑着）。
 *
 * 拿到之后会自己续租，直到 release。所以调用方不用关心自己这一棒要跑多久。
 */
export async function acquireThread(threadId: string): Promise<Lease | null> {
  const token = randomUUID();
  const key = lockKey(threadId);

  const client = await redis.conn();
  const ok = await client.set(key, token, {
    condition: "NX",
    expiration: { type: "PX", value: LOCK_TTL_MS },
  });
  if (ok === null) return null;

  const timer = setInterval(() => {
    void (async () => {
      try {
        const conn = await redis.conn();
        await conn.eval(RENEW_SCRIPT, {
          keys: [key],
          arguments: [token, String(LOCK_TTL_MS)],
        });
      } catch (err) {
        // 续不上就让它过期。这时候强行接着跑才危险——锁一过期别人就进来了
        console.error(`[lock] ${threadId} 续租失败`, err);
      }
    })();
  }, RENEW_MS);
  // 别让这个定时器把进程吊住不退出
  timer.unref();

  return {
    release: async () => {
      clearInterval(timer);
      try {
        const conn = await redis.conn();
        await conn.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
      } catch (err) {
        // 删不掉就等它过期，最多让这个话题多等 30 秒
        console.error(`[lock] ${threadId} 释放失败`, err);
      }
    },
  };
}

/**
 * 这个话题此刻有没有人在推。
 *
 * 给启动捡漏用：`running` 在多副本下有两种意思——上个进程死了留下的，和另一个
 * 副本正跑着的。锁在不在，就是这两者的分界线：有人续着租，说明它活着。
 */
export async function threadBusy(threadId: string): Promise<boolean> {
  try {
    return (await (await redis.conn()).exists(lockKey(threadId))) > 0;
  } catch (err) {
    // 问不出来就当它忙着。宁可这一轮不捡（下次启动还会再看），也别去抢一个可能
    // 正在跑的任务——那会变成两个 claude -p 同时改同一份代码
    console.error("[lock] 查锁失败，当作忙", err);
    return true;
  }
}

export interface PendingEvent {
  job: AgentJob;
  msg: Inbound | null;
  stage: WorkflowStage | null;
}

/** 把一条待办放到队尾，返回放完之后队列有多长 */
export async function pushPending(
  threadId: string,
  event: PendingEvent,
): Promise<number> {
  return (await redis.conn()).lPush(pendingKey(threadId), JSON.stringify(event));
}

/**
 * 取队头那条，空了给 null。
 *
 * 读不出来就丢掉接着取——多半是上个版本写进去的。所以 null 只有一个意思：队列
 * 真的空了。
 */
export async function popPending(threadId: string): Promise<PendingEvent | null> {
  const client = await redis.conn();
  while (true) {
    const raw = await client.rPop(pendingKey(threadId));
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as PendingEvent;
    } catch {
      // 连 JSON 都不是，丢掉
    }
  }
}

/** 还剩几条没处理 */
export async function pendingCount(threadId: string): Promise<number> {
  return (await redis.conn()).lLen(pendingKey(threadId));
}
