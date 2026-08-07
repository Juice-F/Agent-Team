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

const cache = new Map<AgentJob, Model>();

export function modelFor(job: AgentJob): Model {
  let instance = cache.get(job);
  if (!instance) {
    // 标注成 AgentSpec 是必要的：config 那边用了 satisfies，provider 保留成字面量
    // 类型。四个角色碰巧都配 claude 时，下面这句比较会被判成「两边没有交集」而报错
    const spec: AgentSpec = config.agents[job];
    instance =
      spec.provider === "codex" ? new CodexModel(spec) : new ClaudeModel(spec);
    cache.set(job, instance);
  }
  return instance;
}
