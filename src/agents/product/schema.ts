import { z } from "zod";

export const ProductOutputSchema = z.object({
  verdict: z
    .enum(["ask", "plan"])
    .describe(
      "ask = 还有关键的点没定，这一轮先跟用户确认；plan = 该定的都定了，出方案交给研发",
    ),
  question: z
    .string()
    .describe(
      "verdict 为 ask 时，这一轮要确认的那一个点，一句话问清楚；否则给空字符串",
    ),
  options: z
    .array(z.string())
    .max(4)
    .default([])
    .describe(
      "verdict 为 ask 时给 2 到 4 个候选答案，用户在卡片上点按钮选，所以每个都要短（15 字以内）、彼此互斥、能直接当答案用；否则给空数组",
    ),
  plan: z
    .string()
    .describe(
      "verdict 为 plan 时，给研发照着写的方案，markdown。否则给空字符串",
    ),
  reply: z.string().describe("回给用户的话，一到两句"),
});
export type ProductOutput = z.infer<typeof ProductOutputSchema>;
