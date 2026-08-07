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

/**
 * 验收一轮的结论。
 *
 * 判的是「用户要的东西做出来了没有」，不是代码好不好——那是审查那一棒的活，而且
 * 走到这儿说明它已经过了。
 */
export const AcceptOutputSchema = z.object({
  verdict: z
    .enum(["pass", "reject"])
    .describe(
      "pass = 需求做到了，可以收工；reject = 有该做的没做到，得回去重新拆一遍",
    ),
  summary: z
    .string()
    .describe("验收结论，两三句。写给提需求的人看，说清做出来的是什么、够不够用"),
  gaps: z
    .array(z.string())
    .default([])
    .describe(
      "verdict 为 reject 时，一条一句列出哪些要求没做到；pass 时给空数组",
    ),
  request: z
    .string()
    .describe(
      "verdict 为 reject 时，把「这次到底要什么」重写成一段完整需求，产品拿它从头重拆。要把已经做好的部分和这次要补的都算进去，不要只写缺口。pass 时给空字符串",
    ),
});
export type AcceptOutput = z.infer<typeof AcceptOutputSchema>;
