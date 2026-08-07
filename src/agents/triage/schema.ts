import { z } from "zod";

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
