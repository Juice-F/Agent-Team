import { NS, redis } from "./index.js";

export async function claim(key: string, ttlSeconds: number): Promise<boolean> {
  try {
    const client = await redis.conn();
    const ok = await client.set(`${NS}:${key}`, "1", {
      condition: "NX",
      expiration: { type: "EX", value: ttlSeconds },
    });
    return ok !== null;
  } catch (err) {
    console.error("[once] 占位失败，放行", err);
    return true;
  }
}

function filingKey(key: string): string {
  return `${NS}:filed:${key}`;
}

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
