import { WorkflowBuilder } from "./graph.js";
import { Runner } from "./runner.js";
import { TriageAgent } from "../agents/triage/index.js";
import { ProductAgent } from "../agents/product/index.js";
import { DevAgent } from "../agents/dev/index.js";
import { ReviewAgent } from "../agents/review/index.js";

/**
 * 一个任务要走的流程。
 *
 *                    ┌───────────── 验收不通过 ────────────┐
 *                    ▼                                    │
 *   clarifying ──▶ spec ──▶ coding ──▶ review ──▶ accepting ──▶ done
 *                              ▲           │
 *                              └───────────┘
 *                             审查不通过
 *
 *   clarifying  话题助手  需求没说清就在话题里接着问；问清楚了交给产品
 *   spec        产品      把需求拆成研发能照着写的方案
 *   coding      研发      按方案改代码
 *   review      审查      看这一轮改动
 *                           通过   → accepting，交给产品验收
 *                           不通过 → coding，人工确认后返工。代码的问题，需求不动
 *   accepting   产品      验收这一轮做出来的东西
 *                           通过   → done，这个任务到此为止
 *                           不通过 → spec，需求本身得改，回去重新拆一遍
 *                                    
 *   done        —         完成
 */

export const workflow = new WorkflowBuilder({
  triage: new TriageAgent(),
  product: new ProductAgent(),
  dev: new DevAgent(),
  review: new ReviewAgent(),
})
  .next("clarifying", "triage", "澄清需求")
  .next("spec", "product", "拆解需求")
  .next("coding", "dev", "写代码")
  .next("review", "review", "代码审查")
  .next("accepting", "product", "验收")
  .end("done", "完成")
  .edge("review", "coding") // 审查不通过：代码要改，人工确认后返工
  .edge("accepting", "spec") // 验收不通过：不通过的点回去重新拆解需求
  .build();
  
export const runner = new Runner(workflow);
