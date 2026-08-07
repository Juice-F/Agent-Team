export type Provider = "claude" | "codex";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentJob = "triage" | "product" | "dev" | "review";
export interface AgentSpec {
  provider: Provider;
  model: string;
  effort: Effort;
  timeoutMs: number;
}

export type WorkflowStage =
  | "clarifying"
  | "spec"
  | "coding"
  | "review"
  | "accepting"
  | "done";
