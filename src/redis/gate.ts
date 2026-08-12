import { randomUUID } from "node:crypto";
import { gateConfig } from "../config.js";
import { NS, redis } from "./index.js";


export type GateKind = "coding" | "reading";

/**
 * 一个槽位多久没人续租就收回。
 *
 * 和话题锁同一个套路：短 TTL + 续租。拿着槽的进程当场崩掉，最多占着这么久，之后
 * 下一个来抢的人会顺手把它清掉。跑一小时的那一棒靠续租撑，不靠把 TTL 设得很长
 * ——设长了，崩一次就白占一个槽到天亮。
 */
const LEASE_MS = 60_000;
const RENEW_MS = 20_000;

/** 没位置时多久回头看一眼 */
const POLL_MS = 2_000;
/** 加一点随机，别让一堆等待者同时醒过来抢同一个槽 */
const POLL_JITTER_MS = 800;

function gateKey(kind: GateKind): string {
  return `${NS}:gate:${kind}`;
}

function globalMax(kind: GateKind): number {
  return kind === "coding" ? gateConfig.codingMax : gateConfig.readingMax;
}

/**
 * 占一个槽：先清过期的，再数人头，还有位置就把自己加进去。
 *
 * 三步必须在一条 Lua 里。分开发的话，「清过期」和「数人头」之间插进来一个人，
 * 两边都会看到还有空位，然后一起进去——超发的经典写法。
 *
 * 成员是持有者的 token，score 是这个槽的到期时间。用 ZSET 而不是一个 INCR 计数
 * 器，就是为了让崩掉的持有者能被自动清理：计数器减不回来就永久漏一个槽，漏几次
 * 闸门自己就把自己关死了，而且没人看得出来。
 */
const TAKE_SCRIPT = `
redis.call("zremrangebyscore", KEYS[1], 0, ARGV[1])
if redis.call("zcard", KEYS[1]) < tonumber(ARGV[3]) then
  redis.call("zadd", KEYS[1], ARGV[2], ARGV[4])
  return 1
end
return 0
`;

/** 本机此刻占着的重活数 */
let localRunning = 0;

/**
 * 全局这边占一个。
 *
 * Redis 出问题时放行：额度超一点最多是慢，而拦下来是所有任务一起停摆。跟别处
 * 那几道闸的取舍方向一致（见 redis/once.ts）。
 */
async function takeGlobal(kind: GateKind, token: string): Promise<boolean> {
  try {
    const now = Date.now();
    const client = await redis.conn();
    const ok = await client.eval(TAKE_SCRIPT, {
      keys: [gateKey(kind)],
      arguments: [
        String(now),
        String(now + LEASE_MS),
        String(globalMax(kind)),
        token,
      ],
    });
    return ok === 1;
  } catch (err) {
    console.error("[gate] 占位失败，放行", err);
    return true;
  }
}

async function releaseGlobal(kind: GateKind, token: string): Promise<void> {
  try {
    await (await redis.conn()).zRem(gateKey(kind), token);
  } catch (err) {
    // 删不掉就等它过期，最多多占一分钟
    console.error("[gate] 归还失败", err);
  }
}

/**
 * 本机和全局都拿到才算数。
 *
 * 本机那个计数抢在 await 之前先加：先判后加中间隔着一次 await，两个调用会双双
 * 通过判断，最后同时进去，本机上限就形同虚设了。
 */
async function tryTake(kind: GateKind, token: string): Promise<boolean> {
  if (localRunning >= gateConfig.localMax) return false;
  localRunning += 1;
  if (await takeGlobal(kind, token)) return true;
  localRunning -= 1;
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("等闸门时被中断");
}

/**
 * 拿到一个槽再跑 fn，跑完（不管成没成）都还回去。
 *
 * 等的过程里要认中断信号：进程要退了、或者这一棒被打断了，不能还傻等在队列里
 * ——那会让退出卡到超时。
 *
 * @param onWait 第一次没抢到时叫一下，用来告诉外面「在排队」。只叫一次。
 */
export async function withGate<T>(
  kind: GateKind,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
  onWait?: () => void,
): Promise<T> {
  const token = randomUUID();

  let waited = false;
  for (;;) {
    if (signal?.aborted) throw abortReason(signal);
    if (await tryTake(kind, token)) break;
    if (!waited) {
      waited = true;
      onWait?.();
    }
    await sleep(POLL_MS + Math.random() * POLL_JITTER_MS, signal);
  }

  // 拿住之后一路续到干完。续不上就让它过期——那时候别人已经能进来了，硬占着
  // 反而是超发
  const renew = setInterval(() => {
    void (async () => {
      try {
        const client = await redis.conn();
        await client.zAdd(
          gateKey(kind),
          { score: Date.now() + LEASE_MS, value: token },
          { XX: true },
        );
      } catch (err) {
        console.error("[gate] 续租失败", err);
      }
    })();
  }, RENEW_MS);
  renew.unref();

  try {
    return await fn();
  } finally {
    clearInterval(renew);
    localRunning -= 1;
    await releaseGlobal(kind, token);
  }
}
