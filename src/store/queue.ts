/**
 * 按键串行执行 + 事件去重。
 *
 * 队列的键是 thread_id，不是 chat_id —— 这是「一个话题 = 一个任务」能多任务
 * 并行的关键：同一个话题内的消息必须按顺序推进状态机，不同话题之间完全并发。
 * 键换成 chat_id 就退回单线了（一个群同时只能跑一件事）。
 */
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
 * ------------------------------------------------------------------ */
const seen = new Set<string>();
const SEEN_CAP = 2000;

/** 注意：有副作用，同一个 event_id 第二次调用就返回 true。 */
export function isDuplicate(eventId: string | undefined): boolean {
  if (!eventId) return false;
  if (seen.has(eventId)) return true;
  seen.add(eventId);
  if (seen.size > SEEN_CAP) {
    // Set 保序，删掉最早的一半
    for (const key of [...seen].slice(0, SEEN_CAP / 2)) seen.delete(key);
  }
  return false;
}
