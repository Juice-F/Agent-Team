// 上游的产出：话题助手立的那张单子。下游读上游的，依赖跟着流程走。
import { loadTask } from "../triage/index.js";
import { workflow } from "../../workflow.js";
import type {
  ChannelHandler,
  FeishuChannel,
  Inbound,
} from "../../feishu/index.js";

/**
 * 产品经理。状态机还没接进来，先占个位。
 *
 * 它存在的意义是把「谁管哪个阶段」分散到各角色自己身上：话题助手只认
 * clarifying，产品只认 intake。加新阶段时不用回去改一张中心路由表。
 */
export class ProductHandler implements ChannelHandler {
  constructor(private readonly bot: FeishuChannel) {}

  async onThread(threadId: string, msg: Inbound): Promise<void> {
    const task = await loadTask(threadId);
    // 产品认领两个阶段（spec 拆解、accepting 验收），查表比写死字符串省事
    if (!task || workflow.ownerOf(task.stage) !== "product") return;

    // 先回执，确认 thread 标识确实一路带下来了
    await this.bot.replyText(
      task.rootMessageId,
      `[${task.id}] 收到：${msg.text}`,
      { inThread: true },
    );
  }
}
