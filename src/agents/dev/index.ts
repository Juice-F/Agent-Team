import type { Inbound, StepContext, StepResult } from "../../types.js";
import { BaseAgent } from "../base.js";

/**
 * 研发。拿产品拆好的方案动手改代码，交棒给 review。
 *
 * 输入的 note 里可能带着审查的打回意见——被打回时走的是 review → coding 那条边，
 * 这一棒会从头再跑一遍。
 *
 * 还是占位。
 */
export class DevAgent extends BaseAgent {
  constructor() {
    super("dev", ["coding"]);
  }

  async run(ctx: StepContext): Promise<StepResult> {
    // 引擎只拿 handles 里的阶段来叫，这句挡的是类型
    if (ctx.stage !== "coding") return { kind: "wait" };
    return this.pending(ctx, ctx.input.note ? "返工" : "写代码");
  }

  protected async onGroup(_msg: Inbound): Promise<void> {}
}
