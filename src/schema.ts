import { z } from "zod";
import type { WorkflowStage } from "./types.js";

/** 需求本身。澄清阶段还没定下来时 title 是空串。 */
export const RequirementSchema = z.object({
  title: z.string(),
  request: z.string(),
});

/** 产品拆出来的方案。note 是打回意见或上一轮的结论，头一次是空串。 */
export const PlanSchema = z.object({
  plan: z.string(),
  note: z.string().default(""),
});

/** 研发/审查交出来的一轮改动 */
export const ChangeSchema = z.object({
  summary: z.string(),
  changed: z.array(z.string()).default([]),
});

/** 验收完的结论 */
export const OutcomeSchema = z.object({
  summary: z.string(),
});

export const WorkflowStageSchema = {
  clarifying: RequirementSchema,
  spec: RequirementSchema,
  coding: PlanSchema,
  review: ChangeSchema,
  accepting: ChangeSchema,
  done: OutcomeSchema,
} as const satisfies Record<WorkflowStage, z.ZodType>;

export const WorkflowStageEnum = z.enum(
  Object.keys(WorkflowStageSchema) as [WorkflowStage, ...WorkflowStage[]],
);

/**
 * 卡片按钮上挂的东西，飞书原样回传。
 *
 * 按钮回调只带得回消息 id 和群 id，带不回话题 id，所以要找回是哪个任务只能靠
 * 自己塞。stage 也一起塞：卡片会一直留在话题里，翻上去点一张旧卡片上的按钮，
 * 得认得出来它过期了。
 */
export const CardChoiceSchema = z.object({
  threadId: z.string(),
  stage: WorkflowStageEnum,
  /** 点这个按钮等同于用户在话题里说了这句话 */
  text: z.string(),
  /** 认可当前这一版，可以往下走了——认可的是他眼前看到的那一版，不再问模型 */
  confirm: z.boolean().default(false),
});
export type CardChoice = z.infer<typeof CardChoiceSchema>;
