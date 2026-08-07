import { z } from "zod";
import type { WorkflowStage } from "./type.js";

/**
 * 交接单：阶段之间传的东西。
 *
 * 和 type.ts 的 WorkflowStage 一样是业务属性，不是引擎的东西——引擎只知道「每一棒
 * 开工前拿这张 schema 验一遍上一棒交下来的货」，至于货长什么样它不关心。
 *
 * 这是各角色之间唯一的契约。改这里就是改协议，交货那头和收货那头都得跟着改，所以
 * 几张单子放在一起看得见，而不是散在各 agent 里各写各的。
 *
 * 单子只描述「交接的那一刻」，不是角色的全部产出——产品的 tasks.md、研发的 diff
 * 该落哪落哪，交接单里带的是下一棒开工真正需要的那点东西。
 */

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
