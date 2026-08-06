import { WorkflowBuilder, workflow } from "./src/workflow.js";

console.log("流程");
console.log(workflow.describe());

console.log("\n接错线要炸");
const cases: [string, () => unknown][] = [
  ["非法跳转", () => workflow.advance("clarifying", "done")],
  ["有人认领却是死路", () => new WorkflowBuilder().next("a", "dev", "A").build()],
  ["没人认领却有出边", () =>
    new WorkflowBuilder().next("a", null, "A").next("b", "dev", "B").build()],
  ["阶段重名", () =>
    new WorkflowBuilder().next("a", "dev", "A").next("a", "dev", "A2")],
  ["边指向不存在的节点", () =>
    new WorkflowBuilder().next("a", "dev", "A").edge("a", "zzz" as never)],
];
for (const [name, run] of cases) {
  try {
    run();
    console.log(`  ✗ ${name}：没炸`);
  } catch (e) {
    console.log(`  ✓ ${name}：${(e as Error).message}`);
  }
}
