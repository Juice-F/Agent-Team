import type { StageContext, StepResult } from "../../workflow/index.js";
import { BaseAgent } from "../base.js";

/**
 * 产品经理。认领两棒，中间隔着研发和审查。
 *
 *   spec       拿澄清完的需求，拆成研发能照着写的方案，交棒给 coding
 *   accepting  拿审查通过的那轮改动验收；通过交给 done，不通过打回 spec 自己重拆
 *
 * 验收打回落在 spec 而不是 coding：验收没过说明方案本身不对，让研发照着同一份
 * 方案再写一遍没意义。所以打回时交出去的是一份新的需求（Requirement），不是
 * 让人返工的方案。
 *
 * 一个角色管几棒就 switch ctx.stage —— 收窄之后 ctx.input 就是那一棒真正收到的
 * 形状，spec 拿到的是需求，accepting 拿到的是一轮改动，不会串。
 *
 * 两棒都还是占位。真接进来的时候只改这个文件：阶段、边、交接单的形状都已经在
 * 别处说好了。
 */
export class ProductAgent extends BaseAgent<"spec" | "accepting"> {
  constructor() {
    super("product", ["spec", "accepting"]);
  }

  async run(ctx: StageContext<"spec" | "accepting">): Promise<StepResult> {
    switch (ctx.stage) {
      case "spec":
        return this.pending(ctx, `拆解「${ctx.input.title || ctx.task.title}」`);
      case "accepting":
        return this.pending(ctx, `验收：${ctx.input.summary}`);
    }
  }
}
