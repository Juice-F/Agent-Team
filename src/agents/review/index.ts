import type { Inbound, StepContext, StepResult } from "../../types.js";
import { BaseAgent } from "../base.js";

/**
 * 代码审查。拿研发交上来的那轮改动看一遍：过了交给产品验收，没过打回 coding，
 * 打回时把意见塞进 note 一起带回去。
 *
 * 往前还是往回，是这一棒自己决定的——图上两条边都在，走哪条看审查结论。
 *
 * 还是占位。
 */
export class ReviewAgent extends BaseAgent {
  constructor() {
    super("review", ["review"]);
  }

  async run(ctx: StepContext): Promise<StepResult> {
    // 引擎只拿 handles 里的阶段来叫，这句挡的是类型
    if (ctx.stage !== "review") return { kind: "wait" };
    return this.pending(ctx, `审查：${ctx.input.summary}`);
  }

  protected async onGroup(_msg: Inbound): Promise<void> {}
}
