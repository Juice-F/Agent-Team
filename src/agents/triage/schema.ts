import { z } from "zod";
import { StageSchema } from "../../workflow.js";

/**
 * 话题助手这一环的数据形状：模型该吐什么，以及交给下游的那张立项单长什么样。
 *
 * 每个角色都有自己的一份——话题助手产出立项单，产品产出 tasks.md，研发产出
 * diff，形状差得远，不放在一个公共 store 里凑合。下游要什么就 import 上游的，
 * 依赖方向跟着流程走。
 */

/* ------------------------------------------------------------------ *
 * 模型输出
 * ------------------------------------------------------------------ */

export const TriageOutputSchema = z.object({
  verdict: z
    .enum(["task", "ask", "chat"])
    .describe(
      "task = 需求已经清楚，可以立项；ask = 是个需求方向但还差关键信息，需要追问；chat = 不是需求，正常接话",
    ),
  title: z
    .string()
    .describe("verdict 为 task 时给一个 15 字以内的中文短标题；否则给空字符串"),
  request: z
    .string()
    .describe(
      "verdict 为 task 时，把最终确认下来的需求复述成一到三句完整描述，交给产品经理开工用；否则给空字符串",
    ),
  reply: z.string().describe("回给用户的话，一到两句"),
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

/* ------------------------------------------------------------------ *
 * 立项单：交给下游的产出
 * ------------------------------------------------------------------ */

/**
 * 澄清阶段的一来一回。
 *
 * 存下来是因为 `claude -p` 每次调用都是独立进程，没有会话——上下文只能由我们
 * 自己带。跟着立项单落盘，进程重启后接着聊。
 */
export const TurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  /** 话题 ID，任务的主键 */
  threadId: z.string(),
  /** 话题所在的群 */
  chatId: z.string(),
  /**
   * 主群里那条裸消息的 message_id，也就是话题的根。
   * 之后往这个话题里发东西，一律 reply 到它 + reply_in_thread。
   */
  rootMessageId: z.string(),
  /** 话题助手给的短标题。clarifying 阶段可能还是空的 */
  title: z.string(),
  /**
   * 交给产品的需求描述。一句话就说清的就是用户原文；澄清过的是话题助手
   * 综合几轮对话后的复述——产品要看的是问清楚之后的版本，不是最初那句含糊的。
   */
  request: z.string(),
  /** 澄清阶段的往返。立项之后不再追加，产品那边自己管状态。 */
  turns: z.array(TurnSchema).default([]),
  /** 流程走到哪了。图在 workflow.ts，谁认领这个阶段也在那查。 */
  stage: StageSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;
