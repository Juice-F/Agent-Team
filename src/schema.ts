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
