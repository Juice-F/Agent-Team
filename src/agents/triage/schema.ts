import { z } from "zod";

/**
 * 话题助手这一环的数据形状：模型该吐什么。
 *
 * 每个角色都有自己的一份——话题助手判断该不该立项，产品产出 tasks.md，研发产出
 * diff，形状差得远，不放在一个公共 store 里凑合。任务本身那张单子在
 * store/index.ts，阶段之间传的交接单在 schema.ts，都不是这里的事。
 */

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
