import { z } from "zod";

/**
 * 研发跑完一轮交上来的东西。
 *
 * 代码本身已经写进这个任务的工作区了，这里只是那轮改动的说明——审查那一棒会自己去
 * 看仓库，不靠这段文字复原改了什么。
 */
export const DevOutputSchema = z.object({
  summary: z
    .string()
    .describe("这一轮改了什么，两三句。写给审查的人看，不要复述方案原文"),
  changed: z
    .array(z.string())
    .default([])
    .describe("动过的文件，仓库相对路径，比如 src/calc/engine.ts"),
  verified: z
    .string()
    .describe(
      "自查做到哪一步：跑了什么命令、结果怎样。没跑起来就说清为什么，不要编造通过了",
    ),
  concerns: z
    .array(z.string())
    .default([])
    .describe(
      "没做完的、拿不准的、或者跟方案有出入的地方，一条一句。都没有就给空数组",
    ),
});
export type DevOutput = z.infer<typeof DevOutputSchema>;
