import * as lark from "@larksuiteoapi/node-sdk";
import { jobLabelMap } from "../config.js";
import type { AgentJob, Inbound } from "../types.js";
import { enqueue, isDuplicate } from "../utils/queue.js";
import type { Card } from "./card.js";
import type { OnProgress } from "../model/index.js";

type ReceiveEvent = Parameters<
  NonNullable<lark.EventHandles["im.message.receive_v1"]>
>[0];
type Message = ReceiveEvent["message"];
type Sender = ReceiveEvent["sender"];

/**
 * 机器人发的消息，飞书标的是 `bot`。
 *
 * 文档里另有 `app` 这个取值，实测群里机器人发言给的是 `bot`——两个都认，免得哪天
 * 换了又悄悄失效。这个判断错了后果很隐蔽：交棒消息会被当成人在说话，各 agent 里
 * `if (ctx.message)` 的分支全反过来。
 */
const BOT_SENDERS = new Set(["bot", "app"]);

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
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data) => {
        void this.receive(data).catch((err: unknown) => {
          console.error(`[${this.role}]`, err);
        });
      },
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

  replyCard(
    messageId: string,
    card: Card,
    opts: { inThread?: boolean } = {},
  ): Promise<Posted> {
    return this.post(messageId, "interactive", card, opts);
  }

  private async call<T>(
    what: string,
    run: () => Promise<{ code?: number; msg?: string; data?: T }>,
  ): Promise<T | undefined> {
    const fail = (code: unknown, msg: unknown): never => {
      throw new Error(
        `「${jobLabelMap[this.role]}」${what}失败（code=${String(code)}）：${String(msg ?? "无描述")}`,
      );
    };

    let res;
    try {
      res = await run();
    } catch (err) {
      const body = (
        err as { response?: { data?: { code?: number; msg?: string } } }
      )?.response?.data;
      if (body?.msg) fail(body.code, body.msg);
      throw err;
    }
    // 业务错误走的是 code !== 0，HTTP 200，不抛异常
    if (res.code) fail(res.code, res.msg);
    return res.data;
  }

  private async post(
    messageId: string,
    msgType: "text" | "interactive",
    content: unknown,
    opts: { inThread?: boolean } = {},
  ): Promise<Posted> {
    const data = await this.call("回复", () =>
      this.client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: msgType,
          content: JSON.stringify(content),
          reply_in_thread: opts.inThread ?? false,
        },
      }),
    );

    const id = data?.message_id;
    if (!id) {
      throw new Error(`「${jobLabelMap[this.role]}」回复成功但没有返回 message_id`);
    }
    return { messageId: id, threadId: data.thread_id ?? null };
  }

  async patchCard(messageId: string, card: Card): Promise<void> {
    await this.call("更新卡片", () =>
      this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      }),
    );
  }

  /**
   * 把模型的逐字流收成几次卡片更新。
   *
   * 卡片长什么样由调用方给——这一层只管节流和 patch，不拼卡片。render 收到的
   * 是累积到当前为止的进度文本。
   */
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
        void this.patchCard(messageId, render(detail))
          .catch((err: unknown) => {
            console.error(`[${this.role}] 进度更新失败`, err);
          })
          .finally(() => {
            inFlight = false;
          });
      },
      // 停掉之后不再发新的 patch，免得和收尾那次抢同一张卡片
      stop: () => {
        stopped = true;
      },
    };
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

  private isBot(sender: Sender): boolean {
    return !!sender.sender_type && BOT_SENDERS.has(sender.sender_type);
  }

  private async receive(data: ReceiveEvent): Promise<void> {
    const { message, sender } = data;

    // 按角色去重：四个应用各收各的
    if (isDuplicate(this.role, data.event_id)) return;
    
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
