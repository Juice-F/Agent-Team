import { modelFor, type OnProgress } from "../../model/index.js";
import { workspace } from "../../workspace/index.js";
import type { Inbound, StepContext, StepResult } from "../../types.js";
import { BaseAgent } from "../base.js";
import * as cards from "./cards.js";
import { SYSTEM } from "./prompt.js";
import { DevOutputSchema, type DevOutput } from "./schema.js";

/**
 * 研发。拿产品拆好的方案，在这个任务自己那份工作区里动手改代码，交棒给 review。
 *
 * 和前面几棒不一样：这一棒不跟人说话，被推起来就一路跑到底，跑完直接交棒。所以
 * 它是唯一一个开着工具跑模型的角色——代码要真的落到文件里，别处那几棒都是纯生成。
 *
 * 输入的 note 里可能带着审查的打回意见——被打回时走的是 review → coding 那条边，
 * 这一棒会从头再跑一遍，只不过这次是照着意见改。
 */
export class DevAgent extends BaseAgent {
  constructor() {
    super("dev", ["coding"]);
  }

  async run(ctx: StepContext): Promise<StepResult> {
    // 引擎只拿 handles 里的阶段来叫，这句挡的是类型
    if (ctx.stage !== "coding") return { kind: "wait" };
    return this.code(ctx);
  }

  protected async onGroup(_msg: Inbound): Promise<void> {}

  private async code(ctx: CodingContext): Promise<StepResult> {
    const posted = await this.bot.replyCard(
      ctx.task.rootMessageId,
      cards.working(),
      { inThread: true },
    );
    const progress = this.bot.trackProgress(posted.messageId, cards.working);

    let result: DevOutput;
    try {
      result = await this.write(ctx, progress.on);
    } catch (err) {
      await this.bot.patchCard(posted.messageId, cards.failed());
      throw err;
    } finally {
      progress.stop();
    }

    await this.bot.patchCard(posted.messageId, cards.done(ctx.task, result));
    return {
      kind: "next",
      to: "review",
      output: { summary: this.brief(result), changed: result.changed },
    };
  }

  private async write(
    ctx: CodingContext,
    onProgress: OnProgress,
  ): Promise<DevOutput> {
    // 开工前自己确认一遍工作区在不在：任务是落盘的，轮到这一棒时它可能已经换了
    // 台机器，或者目录被清掉了
    const dir = await workspace.ensure(ctx.task);

    const parts = [
      `需求：${ctx.task.title}`,
      `产品定下来的方案：\n${ctx.input.plan}`,
    ];
    // 打回来的那一轮，note 里是审查意见
    if (ctx.input.note) {
      parts.push(
        `上一轮被打回了，审查意见：\n${ctx.input.note}\n\n这一轮只解决这些意见，方案没变，不要推翻重写。`,
      );
    }

    return modelFor("dev").generate({
      system: SYSTEM,
      user: parts.join("\n\n"),
      schema: DevOutputSchema,
      // 唯一一处放开写权限的调用：代码得真的落进这个任务自己那份工作区
      repo: { path: dir, write: true },
      onProgress,
      signal: ctx.signal,
    });
  }

  /**
   * 交给审查的那句话。
   *
   * concerns 拼进 summary 一起送——ChangeSchema 只有 summary 和 changed 两个字段，
   * 而「哪儿没做完、哪儿跟方案有出入」恰恰是审查最该先看的。
   */
  private brief(result: DevOutput): string {
    if (!result.concerns.length) return result.summary;
    const list = result.concerns.map((c) => `- ${c}`).join("\n");
    return `${result.summary}\n\n研发自己标出来的待确认点：\n${list}`;
  }
}

type CodingContext = Extract<StepContext, { stage: "coding" }>;
