import { config } from "../config.js";
import type { AgentJob, AgentSpec } from "../types.js";
import { Model } from "./base.js";
import { ClaudeModel } from "./claude/index.js";
import { CodexModel } from "./codex/index.js";

export {
  Model,
  ModelError,
  type GenerateOptions,
  type ModelProgress,
  type OnProgress,
} from "./base.js";

// 按规格去重，不按角色：两个角色配了同一档模型就共用一个实例
const cache = new Map<string, Model>();

export function modelFor(job: AgentJob): Model {
  // 标注成 AgentSpec 是必要的：config 那边用了 satisfies，provider 保留成字面量
  // 类型。四个角色碰巧都配 claude 时，modelOf 里那句比较会被判成「两边没有交集」而报错
  const spec: AgentSpec = config.agents[job];
  return modelOf(spec);
}

/**
 * 不挂在角色上的模型。
 *
 * 路由那几档（分类、小模型答、大模型评测）不属于流程里的任何一棒，也就没有
 * AgentJob 可查，直接拿规格要。
 */
export function modelOf(spec: AgentSpec): Model {
  const key = `${spec.provider}/${spec.model}/${spec.effort}/${spec.timeoutMs}`;
  let instance = cache.get(key);
  if (!instance) {
    instance =
      spec.provider === "codex" ? new CodexModel(spec) : new ClaudeModel(spec);
    cache.set(key, instance);
  }
  return instance;
}
