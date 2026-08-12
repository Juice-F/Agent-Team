import * as lark from "@larksuiteoapi/node-sdk";
import { jobLabelMap } from "../config.js";
import type { AgentJob, Inbound } from "../types.js";
import { enqueue } from "../utils/queue.js";
import { hasButtons, settleCard, type Card } from "./card.js";
import type { OnProgress } from "../model/index.js";

type ReceiveEvent = Parameters<
  NonNullable<lark.EventHandles["im.message.receive_v1"]>
>[0];
type Message = ReceiveEvent["message"];
export interface Posted {
  messageId: string;
  threadId: string | null;
}

/**
 * 每个角色自己的交互逻辑。
 *
 * 这个文件只管收发，不知道什么是立项、什么是澄清——那些在 agents 下面，各角色
 * 各写各的。方向是单向的：agents 依赖 feishu，feishu 不认识 agents。
 */
export interface ChannelHandler {
  /** 主群里的消息（不在任何话题内）。@ 不 @ 我都算。 */
  onGroup?(msg: Inbound): Promise<void>;
  /** 话题内的消息。已按话题串行，同一话题不会并发进来。 */
  onThread?(threadId: string, msg: Inbound): Promise<void>;
  /**
   * 用户点了卡片上的按钮。返回的话会以 toast 的形式弹给点的那个人。
   *
   * 必须立刻返回：飞书等这个回调的响应，超时就在用户那边显示成失败。真正要干的
   * 活得挂到后台去，别在这儿 await。
   */
  onCardAction?(action: CardAction): Promise<string>;
}

/** 用户点按钮这件事。value 是我们自己挂在按钮上的，飞书原样送回。 */
export interface CardAction {
  value: Record<string, unknown>;
  /**
   * 卡片上表单填的值，按组件的 name 取。普通按钮没有表单，这里是空的。
   */
  formValue: Record<string, string>;
  /** 承载这个按钮的那张卡片 */
  messageId: string;
  chatId: string;
}

/** 卡片更新的最小间隔。飞书对消息更新有频控，逐字流式在 IM 里是行不通的。 */
const PATCH_INTERVAL_MS = 2000;
/**
 * 进度详情的长度上限。放在折叠面板里，不用像铺在正文时那样掐到几十字，
 * 但仍要封顶——思考链能跑很长，整段塞进卡片会把请求体撑大。
 */
const DETAIL_MAX = 600;

export class FeishuChannel {
  private readonly client: lark.Client;
  private readonly ws: lark.WSClient;
  private handler: ChannelHandler = {};
  private readonly clickable = new Map<string, Card>();
  openId: string | null = null;

  constructor(
    readonly role: AgentJob,
    readonly cred: {
      appId: string;
      appSecret: string;
    },
  ) {
    this.client = new lark.Client({
      appId: cred.appId,
      appSecret: cred.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });
    this.ws = new lark.WSClient({
      appId: cred.appId,
      appSecret: cred.appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
    });
  }

  async resolveOpenId(): Promise<void> {
    const res = (await this.client.request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
    })) as { bot?: { open_id?: string } } | undefined;

    this.openId = res?.bot?.open_id ?? null;
    if (!this.openId) {
      throw new Error(
        `「${jobLabelMap[this.role]}」问不到自己的 open_id，别的角色 @ 不到它，流程会卡住`,
      );
    }
  }

  async start(handler: ChannelHandler = {}): Promise<void> {
    this.handler = handler;
    const dispatcher = new lark.EventDispatcher({}).register<{
      "card.action.trigger": (data: lark.RawCardActionEvent) => Promise<unknown>;
    }>({
      "im.message.receive_v1": (data) => {
        void this.receive(data).catch((err: unknown) => {
          console.error(`[${this.role}]`, err);
        });
      },
      "card.action.trigger": (data) => this.clicked(data),
    });
    await this.ws.start({ eventDispatcher: dispatcher });
  }

  replyText(
    messageId: string,
    text: string,
    opts: { inThread?: boolean } = {},
  ): Promise<Posted> {
    return this.post(messageId, "text", { text }, opts);
  }

  async replyCard(
    messageId: string,
    card: Card,
    opts: { inThread?: boolean } = {},
  ): Promise<Posted> {
    const posted = await this.post(messageId, "interactive", card, opts);
    this.remember(posted.messageId, card);
    return posted;
  }

  private async post(
    messageId: string,
    msgType: "text" | "interactive",
    content: unknown,
    opts: { inThread?: boolean } = {},
  ): Promise<Posted> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: msgType,
        content: JSON.stringify(content),
        reply_in_thread: opts.inThread ?? false,
      },
    });

    const data = res.data;
    if (!data?.message_id) {
      throw new Error(
        `「${jobLabelMap[this.role]}」回复失败（code=${String(res.code)}）：${res.msg ?? "无描述"}`,
      );
    }
    return { messageId: data.message_id, threadId: data.thread_id ?? null };
  }

  async patchCard(messageId: string, card: Card): Promise<void> {
    try {
      const res = await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    
      if (res.code) {
        console.error(
          `[${this.role}] 更新卡片失败（code=${String(res.code)}）：${res.msg ?? "无描述"}`,
        );
        return;
      }
      this.remember(messageId, card);
    } catch (err) {
      console.error(`[${this.role}] 更新卡片失败`, err);
    }
  }

  /** 卡片上有按钮就留一份，没有就把之前留的清掉——按钮被自己盖掉了 */
  private remember(messageId: string, card: Card): void {
    if (hasButtons(card)) this.clickable.set(messageId, card);
    else this.clickable.delete(messageId);
  }

  /**
   * 抹掉这张卡片上的按钮。
   *
   * 先摘出来再改：两下连点会同时进到这儿，第一下摘走之后第二下就什么都拿不到，
   * 不会重复 patch。
   */
  private async settle(messageId: string, chosen: string): Promise<void> {
    const card = this.clickable.get(messageId);
    if (!card) return;
    this.clickable.delete(messageId);
    await this.patchCard(messageId, settleCard(card, chosen));
  }

  trackProgress(
    messageId: string,
    render: (detail: string) => Card,
  ): { on: OnProgress; stop: () => void } {
    let buffer = "";
    let lastAt = 0;
    let inFlight = false;
    let stopped = false;

    return {
      on: (p) => {
        buffer = p.kind === "tool" ? `调用 ${p.text}` : buffer + p.text;

        const now = Date.now();
        if (stopped || inFlight || now - lastAt < PATCH_INTERVAL_MS) return;
        lastAt = now;
        inFlight = true;

        const detail = buffer.replace(/\s+/g, " ").trim().slice(-DETAIL_MAX);
        // 不 await：进度更新慢了不能拖住模型那条流
        void this.patchCard(messageId, render(detail)).finally(() => {
          inFlight = false;
        });
      },
      stop: () => {
        stopped = true;
      },
    };
  }

  private async clicked(data: lark.RawCardActionEvent): Promise<unknown> {
    const value = data.action?.value;
    const messageId = data.context?.open_message_id ?? data.open_message_id;
    const chatId = data.context?.open_chat_id ?? data.open_chat_id;
    if (!value || typeof value !== "object" || !messageId || !chatId) return;

    const onCardAction = this.handler.onCardAction;
    if (!onCardAction) return;

    let toast: string;
    try {
      toast = await onCardAction({
        value: value as Record<string, unknown>,
        formValue: ((data.action as { form_value?: unknown } | undefined)?.form_value || {}) as Record<string, string>,
        messageId,
        chatId,
      });
    } catch (err) {
      console.error(`[${this.role}] 按钮回调`, err);
      toast = "没处理成功，看下日志";
    }

    // 不 await：飞书等着这个响应，抹按钮是另一次请求，让它自己在后面跑
    const chosen = (value as { text?: unknown }).text;
    void this.settle(messageId, typeof chosen === "string" ? chosen : "已处理");

    return { toast: { type: "info", content: toast } };
  }

  private extractText(message: Message): string {
    try {
      const parsed = JSON.parse(message.content) as { text?: string };
      let text = parsed.text ?? "";
      for (const mention of message.mentions ?? []) {
        text = text.split(mention.key).join(" ");
      }
      return text.trim();
    } catch {
      return "";
    }
  }

  private mentionsMe(message: Message): boolean {
    return (message.mentions ?? []).some((m) => m.id?.open_id === this.openId);
  }

  private async receive(data: ReceiveEvent): Promise<void> {
    const { message, sender } = data;

    if (sender.sender_id?.open_id === this.openId) return;
    if (sender.sender_type === "bot" && !this.mentionsMe(message)) return;
    if (message.message_type !== "text") return;

    const text = this.extractText(message);
    // 只 @ 了一下没说话
    if (!text) return;

    const inbound: Inbound = {
      text,
      messageId: message.message_id,
      chatId: message.chat_id,
      fromBot: sender.sender_type === "bot",
    };

    const threadId = message.thread_id;
    if (threadId) {
      const onThread = this.handler.onThread;
      if (!onThread) return;
      await enqueue(threadId, () => onThread.call(this.handler, threadId, inbound));
      return;
    }

    if (this.mentionsMe(message) || !message.mentions?.length) {
      await this.handler.onGroup?.(inbound);
    }
  }
}
