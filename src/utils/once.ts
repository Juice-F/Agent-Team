import { NS, redis } from "../redis.js";

/**
 * 这个会话单元能不能立项。抢到的那条消息才往下走，后面的一律不再开新任务。
 *
 * key 是「一次对话」的身份，各平台不一样，所以由调用方给：
 *
 *   飞书  话题就是一次对话，传 thread_id——一个群里同时挂着几个需求是正常的，
 *         各走各的话题，互不影响。
 *   钉钉  没有话题这层，一个群就是一次对话，传 group_id——用户在群里连发两条，
 *         第一条立了项，第二条就不该再开一个任务出来。
 *
 */
export async function claimFiling(key: string): Promise<boolean> {
  try {
    const client = await redis.conn();
    return (await client.set(filingKey(key), "1", { condition: "NX" })) !== null;
  } catch (err) {
    console.error("[once] 立项占位失败，放行", err);
    return true;
  }
}

export async function releaseFiling(key: string): Promise<void> {
  try {
    await (await redis.conn()).del(filingKey(key));
  } catch (err) {
    console.error("[once] 立项名额没还回去", err);
  }
}

function filingKey(key: string): string {
  return `${NS}:filed:${key}`;
}
