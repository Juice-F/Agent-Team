import { jobLabelMap } from "./config.js";
import { modelFor } from "./model/index.js";
import { postgres } from "./postgres/index.js";
import { redis } from "./redis/index.js";
import { sessionStore } from "./postgres/session.js";
import { runner } from "./workflow/index.js";
import { tracer } from "./trace/index.js";
import { type AgentJob } from "./types.js";

async function main(): Promise<void> {
  console.log("Agent Team");
  for (const [job, label] of Object.entries(jobLabelMap)) {
    const { spec } = modelFor(job as AgentJob);
    console.log(
      `  ${label}  ${spec.model} / effort ${spec.effort} / ${spec.timeoutMs / 1000}s`,
    );
  }

  await postgres.connect();
  await redis.connect();
  
  await sessionStore.init();
  await tracer.init();
  await runner.start(sessionStore);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // 掐掉正在跑的模型调用。任务这时在库里还写着 running，下次启动照样捡得回来，
    const stopped = runner?.interruptAll("进程退出") ?? 0;
    console.log(stopped ? `\n正在退出…（中断 ${stopped} 个任务）` : "\n正在退出…");
    // 现场是后台写的，不等一下最后几条就跟着进程一起没了——而被中断的那几次
    // 恰恰是最想留下现场的
    void tracer
      .drain()
      .then((n) => {
        if (n) console.log(`[trace] 等 ${n} 条现场落完`);
      })
      .catch((err: unknown) => {
        console.error("[trace] drain 失败", err);
      })
      .then(() => Promise.allSettled([redis.close(), postgres.close()]))
      .finally(() => {
        process.exit(0);
      });
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
