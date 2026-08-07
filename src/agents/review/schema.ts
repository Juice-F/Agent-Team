import { z } from "zod";

/**
 * 审查一轮的结论。
 *
 * 只有过和不过两种。「基本没问题但有几个小建议」一律算过——建议写进 summary，
 * 别拿它把任务打回去空转一轮。
 */
export const ReviewOutputSchema = z.object({
  verdict: z
    .enum(["pass", "reject"])
    .describe(
      "pass = 这轮改动可以交付；reject = 有必须先改掉的问题，要打回给研发返工",
    ),
  summary: z
    .string()
    .describe("审查结论，两三句。说清看了什么、判断依据是什么"),
  issues: z
    .array(
      z.object({
        file: z
          .string()
          .describe("问题所在文件的仓库相对路径。跨文件的问题给空字符串"),
        detail: z
          .string()
          .describe("问题是什么、为什么必须改。一条一句，要让研发看完就知道怎么动手"),
      }),
    )
    .default([])
    .describe("verdict 为 reject 时必须列出问题；pass 时给空数组"),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
