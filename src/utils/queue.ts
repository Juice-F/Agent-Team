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
