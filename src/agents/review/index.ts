import type { StageContext, StepResult } from "../../workflow/index.js";
import { BaseAgent } from "../base.js";

/**
 * 代码审查。拿研发交上来的那轮改动看一遍：过了交给产品验收，没过打回 coding，
 * 打回时把意见塞进 note 一起带回去。
 *
 * 往前还是往回，是这一棒自己决定的——图上两条边都在，走哪条看审查结论。
 *
 * 还是占位。
 */
export class ReviewAgent extends BaseAgent<"review"> {
  constructor() {
    super("review", ["review"]);
  }

  async run(ctx: StageContext<"review">): Promise<StepResult> {
    return this.pending(ctx, `审查：${ctx.input.summary}`);
  }
}
