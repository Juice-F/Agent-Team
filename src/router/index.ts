import { modelOf, type OnProgress } from "../model/index.js";
import type { TraceContext } from "../trace/type.js";
import { routerConfig, routerModels, type RouterConfig } from "./config.js";
import { CLASSIFIER, JUDGE, RESPONDER } from "./prompt.js";
import { matchRule } from "./rules.js";
import {
  JudgeSchema,
  ReplySchema,
  RouteVerdictSchema,
  type RouteLabel,
} from "./schema.js";

export { routerConfig, routerModels, type RouterConfig } from "./config.js";
export type { RouteLabel } from "./schema.js";

export interface RouteDecision {
  readonly label: RouteLabel;
  /** 规则命中记 1；模型判的记它自己给的分；判不出来记 0 */
  readonly confidence: number;
  /** 这个结论是谁给的：规则 / 分类器 / 出错兜底 */
  readonly by: "rule" | "model" | "fallback";
  /** by 为 rule 时是命中的规则名，方便看日志时知道被哪条拦下的 */
  readonly rule?: string;
  /** 规则自带的回复，有就直接发，别再往下走小模型那条链 */
  readonly reply?: string;
}

export interface RouterCall {
  readonly signal?: AbortSignal;
  /**
   * 记链路用的身份。路由这三档不属于流程里任何一棒，但它们是**每条群消息都要跑**
   * 的——分类一次、答一次、评一次，量比后面几棒大得多。不记的话，账单上最先长
   * 起来的那块反而是看不见的。
   */
  readonly trace?: TraceContext;
}

/** 三档共用一个上下文，只把 job 换掉，事后才分得出是哪一档在花钱 */
function as(
  trace: TraceContext | undefined,
  job: string,
): { trace?: TraceContext } {
  return trace ? { trace: { ...trace, job } } : {};
}

export type SimpleAnswer =
  | {
      /** 小模型这句过了评测，发出去就完了 */
      readonly kind: "reply";
      readonly reply: string;
      readonly score: number | null;
    }
  | {
      readonly kind: "escalate";
      /** low-score 是评测判的 */
      readonly why: "low-score" | "answer-failed" | "judge-failed";
      /** 只有 low-score 有分，跑挂了没分 */
      readonly score: number | null;
      readonly reason: string;
    };

/**
 * 话题助手前置判断。
 *
 * 规则 → 分类器 → 小模型答 → 大模型评 →（分不够）退回去开话题做立项需求澄清。
 *
 */
export class ModelRouter {
  constructor(private readonly cfg: RouterConfig = routerConfig) {}

  async route(text: string, opts: RouterCall = {}): Promise<RouteDecision> {
    const hit = matchRule(text);
    if (hit) {
      return {
        label: hit.label,
        confidence: 1,
        by: "rule",
        rule: hit.name,
        ...(hit.reply && { reply: hit.reply }),
      };
    }

    let verdict;
    try {
      verdict = await modelOf(routerModels.small).generate({
        system: CLASSIFIER,
        user: text,
        schema: RouteVerdictSchema,
        signal: this.deadline(this.cfg.classifierTimeoutMs, opts.signal),
        ...as(opts.trace, "classifier"),
      });
    } catch (err) {
      console.error("[router] 意图识别没跑出来，按 COMPLEX 走", err);
      return { label: "COMPLEX", confidence: 0, by: "fallback" };
    }

    const confident =
      verdict.label === "SIMPLE" && verdict.confidence >= this.cfg.simpleThreshold;
    return {
      label: confident ? "SIMPLE" : "COMPLEX",
      confidence: verdict.confidence,
      by: "model",
    };
  }

  async answer(
    text: string,
    opts: RouterCall & { onProgress?: OnProgress } = {},
  ): Promise<SimpleAnswer> {
    let draft;
    try {
      draft = await modelOf(routerModels.small).generate({
        system: RESPONDER,
        user: `用户在群里说：\n\n${text}`,
        schema: ReplySchema,
        onProgress: opts.onProgress,
        signal: this.deadline(this.cfg.answerTimeoutMs, opts.signal),
        ...as(opts.trace, "responder"),
      });
    } catch (err) {
      return {
        kind: "escalate",
        why: "answer-failed",
        score: null,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    if (!this.cfg.enableCascade) {
      return { kind: "reply", reply: draft.reply, score: null };
    }

    let judged;
    try {
      judged = await modelOf(routerModels.large).generate({
        system: JUDGE,
        user: `用户说：\n\n${text}\n\n机器人的回复：\n\n${draft.reply}`,
        schema: JudgeSchema,
        signal: this.deadline(this.cfg.judgeTimeoutMs, opts.signal),
        ...as(opts.trace, "judge"),
      });
    } catch (err) {
      return {
        kind: "escalate",
        why: "judge-failed",
        score: null,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    if (judged.score < this.cfg.cascadeScoreThreshold) {
      return {
        kind: "escalate",
        why: "low-score",
        score: judged.score,
        reason: judged.reason,
      };
    }
    return { kind: "reply", reply: draft.reply, score: judged.score };
  }

  private deadline(ms: number, signal?: AbortSignal): AbortSignal {
    const timer = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timer]) : timer;
  }
}

export const router = new ModelRouter();
