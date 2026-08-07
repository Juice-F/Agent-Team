import { jobLabelMap, config } from "./config.js";
import { modelFor } from "./model/index.js";
import { sessionStore } from "./store/index.js";
import { workflow } from "./workflow/index.js";
import { type AgentJob } from "./types.js";
import { type Runner } from "./workflow/runner.js";

let runner: Runner | null = null;

async function main(): Promise<void> {
  console.log("Agent Team");
  console.log(`  目标仓库  ${config.targetRepo}`);
  console.log(`  会话目录  ${config.sessionsDir}`);
  for (const [job, label] of Object.entries(jobLabelMap)) {
    const { spec } = modelFor(job as AgentJob);
    console.log(
      `  ${label}  ${spec.model} / effort ${spec.effort} / ${spec.timeoutMs / 1000}s`,
    );
  }

  // 拉起所有角色的服务，顺便把上次中断在半路的任务捡回来接着跑
  runner = await workflow.run(sessionStore);
  console.log("\n群里直接说需求，话题助手会判断该不该立项。Ctrl+C 退出。\n");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // 掐掉正在跑的模型调用。任务文件这时还写着 running，下次启动照样捡得回来，
    const stopped = runner?.interruptAll("进程退出") ?? 0;
    console.log(stopped ? `\n正在退出…（中断 ${stopped} 个任务）` : "\n正在退出…");
    process.exit(0);
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
