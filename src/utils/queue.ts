const queues = new Map<string, Promise<unknown>>();

export function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  // 成功失败都接着跑下一个，否则一次失败会让这个话题的队列永久卡住
  const result = prev.then(task, task);

  // 存进 map 的是吞掉异常的版本，避免把 rejection 传染给后续任务
  const chained = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, chained);
  void chained.then(() => {
    if (queues.get(key) === chained) queues.delete(key);
  });

  return result;
}

/* ------------------------------------------------------------------ *
 * 事件去重
 *
 * 飞书在未及时收到 ack 时会重推同一事件，event_id 不变。重复处理会重复回消息。
 * 内存态，进程重启后失效——重启期间补推的事件拦不住，可接受。
 *
 * 按 scope 分开记：四个角色各是一个独立的飞书应用，同一条群消息四个都会收到。
 * 要是共用一个集合，万一飞书给四个应用发的是同一个 event_id，第一个处理完就把
 * 它标记掉了，剩下三个会被静默丢弃——交棒消息永远送不到下一棒，而且现象是
 * 「任务莫名其妙停住」，很难往这上面想。去重本来就该每个订阅方各去各的。
 * ------------------------------------------------------------------ */
const seen = new Map<string, Set<string>>();
const SEEN_CAP = 2000;

/**
 * 注意：有副作用，同一个 scope 下同一个 event_id 第二次调用就返回 true。
 *
 * @param scope 谁在去重。传角色名，各角色互不干扰。
 */
export function isDuplicate(scope: string, eventId: string | undefined): boolean {
  if (!eventId) return false;

  let ids = seen.get(scope);
  if (!ids) {
    ids = new Set();
    seen.set(scope, ids);
  }

  if (ids.has(eventId)) return true;
  ids.add(eventId);
  if (ids.size > SEEN_CAP) {
    // Set 保序，删掉最早的一半
    for (const key of [...ids].slice(0, SEEN_CAP / 2)) ids.delete(key);
  }
  return false;
}
