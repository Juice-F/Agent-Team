import { config, type AgentJob } from "../config.js";
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
    const spec = config.agents[job];
    instance =
      spec.provider === "codex" ? new CodexModel(spec) : new ClaudeModel(spec);
    cache.set(job, instance);
  }
  return instance;
}
