import type { StageContext, StepResult } from "../../workflow/index.js";
import { BaseAgent } from "../base.js";

/**
 * 研发。拿产品拆好的方案动手改代码，交棒给 review。
 *
 * 输入的 note 里可能带着审查的打回意见——被打回时走的是 review → coding 那条边，
 * 这一棒会从头再跑一遍。
 *
 * 还是占位。
 */
export class DevAgent extends BaseAgent<"coding"> {
  constructor() {
    super("dev", ["coding"]);
  }

  async run(ctx: StageContext<"coding">): Promise<StepResult> {
    return this.pending(ctx, ctx.input.note ? "返工" : "写代码");
  }
}
