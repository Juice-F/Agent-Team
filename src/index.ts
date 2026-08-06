import { jobLabelMap, config, feishu, type AgentJob } from "./config.js";
import { FeishuChannel } from "./feishu/index.js";
import { modelFor } from "./model/index.js";
import { workflow } from "./workflow.js";
import { TriageHandler } from "./agents/triage/index.js";
import { ProductHandler } from "./agents/product/index.js";

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
  console.log("\n流程");
  console.log(workflow.describe());
  console.log("");

  const bots = {
    triage: new FeishuChannel("triage", feishu.triage),
    product: new FeishuChannel("product", feishu.product),
    dev: new FeishuChannel("dev", feishu.dev),
    review: new FeishuChannel("review", feishu.review),
  };

  await Promise.all([
    bots.triage.start(new TriageHandler(bots.triage)),
    bots.product.start(new ProductHandler(bots.product)),
    bots.dev.start(),
    bots.review.start(),
  ]);

  console.log("\n群里 @ 话题助手说需求，它判断该不该立项。Ctrl+C 退出。\n");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\n正在退出…");
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
