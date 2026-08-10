import type { AgentSpec } from "../types.js";

export interface RouterConfig {
  /** 分类器判 SIMPLE 时，置信度得压过这条线才让小模型自己答 */
  simpleThreshold: number;
  /** 分类器的截止时间，超了按 COMPLEX 走 */
  classifierTimeoutMs: number;
  /** 小模型答那一步的截止时间，超了立项需求澄清 */
  answerTimeoutMs: number;
  /** 大模型评测那一步的截止时间，超了立项需求澄清 */
  judgeTimeoutMs: number;
  /** 关掉就直接发小模型那版，不评测 */
  enableCascade: boolean;
  /** 评测分低于这条线就退回去做立项需求澄清，不发小模型那版（满分 10） */
  cascadeScoreThreshold: number;
}

export const routerConfig: RouterConfig = {
  simpleThreshold: 0.85,
  classifierTimeoutMs: 20_000,
  answerTimeoutMs: 30_000,
  judgeTimeoutMs: 45_000,
  enableCascade: true,
  cascadeScoreThreshold: 7,
};

export const routerModels = {
  small: {
    provider: "claude",
    model: "claude-sonnet-5",
    effort: "low",
    timeoutMs: 60_000,
  },
  large: {
    provider: "claude",
    model: "claude-opus-5",
    effort: "medium",
    timeoutMs: 120_000,
  }
} as Record<"small" | "large", AgentSpec>;
