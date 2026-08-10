import { z } from "zod";

export const RouteLabelSchema = z.enum(["SIMPLE", "COMPLEX"]);
export type RouteLabel = z.infer<typeof RouteLabelSchema>;

export const RouteVerdictSchema = z.object({
  label: RouteLabelSchema.describe(
    "SIMPLE = 一句话就能答完；COMPLEX = 要研发团队立项落地，或者信息不全得追问",
  ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("0 到 1 的小数，对上面这个判断有多确定"),
});
export type RouteVerdict = z.infer<typeof RouteVerdictSchema>;

export const ReplySchema = z.object({
  reply: z.string().trim().min(1).describe("回给用户的话，一到两句"),
});

export const JudgeSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(10)
    .describe(
      "0 到 10 分：≥ 7 = 这条回复发给用户，< 7 = 退回去开话题做立项需求澄清",
    ),
  reason: z.string().describe("一句话说明为什么该发出去、或者为什么该退回去"),
});
