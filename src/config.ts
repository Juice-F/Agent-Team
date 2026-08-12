import "dotenv/config";
import type { AgentJob, AgentSpec } from "./types.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}，请在 .env 中配置`);
  return value;
}

export const jobLabelMap: Record<AgentJob, string> = {
  triage: "立项判断",
  product: "需求拆解",
  dev: "代码编写",
  review: "代码审查",
} as const;

export const config = {
  agents: {
    triage: { 
      provider: "claude",
      model: "claude-sonnet-5",
      effort: "low",
      timeoutMs: 60_000
    },
    product: { 
      provider: "claude",
      model: "claude-fable-5",
      effort: "high",
      timeoutMs: 600_000
    },
    dev: { 
      provider: "claude",
      model: "claude-opus-5",
      effort: "high",
      timeoutMs: 3600_000
    },
    review: { 
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      timeoutMs: 600_000
    },
  } satisfies Record<AgentJob, AgentSpec>,
} as const;

export const feishu = {
  triage: {
    appId: required("FEISHU_TRIAGE_APP_ID"),
    appSecret: required("FEISHU_TRIAGE_APP_SECRET"),
  },
  product: {
    appId: required("FEISHU_PRODUCT_APP_ID"),
    appSecret: required("FEISHU_PRODUCT_APP_SECRET"),
  },
  dev: {
    appId: required("FEISHU_DEV_APP_ID"),
    appSecret: required("FEISHU_DEV_APP_SECRET"),
  },
  review: {
    appId: required("FEISHU_REVIEW_APP_ID"),
    appSecret: required("FEISHU_REVIEW_APP_SECRET"),
  }
} as const;
