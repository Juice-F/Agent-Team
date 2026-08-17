import { postgres } from "../postgres/index.js";
import { renderCall } from "./call.js";
import { renderTask } from "./task.js";

/**
 * 链路回放。
 *
 * 记下来的东西得有地方看，不然就是写进去没人读的死数据。这一层只读不写：
 * 汇总从 PG 扫，完整现场从对象存储捞（见 src/trace/）。
 *
 *   pnpm trace task <taskId>       一个任务的完整调用链
 *   pnpm trace call <key|callId>   某一次调用内部的工具时间线
 */
const USAGE = [
  "用法：",
  "  pnpm trace task <taskId>       一个任务的完整调用链",
  "  pnpm trace call <key|callId>   某一次调用内部的工具时间线",
  "",
  "taskId / callId 给一段就行，会按包含匹配找。",
].join("\n");

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  if (command === "task" && arg) {
    console.log(await renderTask(arg));
    return;
  }
  if (command === "call" && arg) {
    console.log(await renderCall(arg));
    return;
  }
  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  })
  // CLI 跑完就得退，不关池子的话 node 会挂在那儿等连接超时
  .finally(() => void postgres.close().catch(() => {}));
