import { z } from "zod";
import type { AgentJob } from "./config.js";

/**
 * 一个任务要走的流程。
 *
 *                  ┌──────────────── 还有下一步 ────────────────┐
 *                  ▼                                           │
 *   clarifying ─▶ spec ─▶ coding ─▶ review ──── 通过 ───▶ accepting ─▶ done
 *    话题助手     产品     研发      审查                  产品         终点
 *                          ▲          │
 *                          └─ 打回重改 ┘
 *
 * `.next()` 按顺序声明主干，前后自动连边；`.edge()` 补主干表达不了的那些——打回、
 * 返工、跳步。分成两个方法是因为这条流程不是一条直线：审查和研发之间有环，验收
 * 之后还能再来一轮，链式调用只能往前走，环得单独说。
 *
 * 这个文件不认识任何 agent 的实现，只认识 config 里的角色名，所以谁都能 import
 * 它而不会绕出循环依赖。
 */

interface Node<S extends string> {
  readonly stage: S;
  readonly label: string;
  /** 谁在这个节点干活。终点没人认领。 */
  readonly owner: AgentJob | null;
  readonly next: S[];
}

/**
 * 流程的构造器。
 *
 * 泛型 S 随着 `.next()` 一路累积已声明的阶段名，所以 `.edge()` 只接受已经存在的
 * 节点——拼错一个字编译期就红，不用等到运行时任务卡死才发现。
 */
export class WorkflowBuilder<S extends string = never> {
  private readonly nodes: Node<string>[] = [];

  /**
   * 接一个阶段到主干末尾，自动从上一个阶段连一条边过来。
   *
   * owner 传 null 表示终点，没人认领。
   */
  next<N extends string>(
    stage: N,
    owner: AgentJob | null,
    label: string,
  ): WorkflowBuilder<S | N> {
    if (this.nodes.some((n) => n.stage === stage)) {
      throw new Error(`阶段 ${stage} 声明了两次`);
    }
    this.nodes.at(-1)?.next.push(stage);
    this.nodes.push({ stage, owner, label, next: [] });
    return this as unknown as WorkflowBuilder<S | N>;
  }

  /** 主干之外的边：打回、返工、跳步。两端都必须是已经声明过的阶段。 */
  edge(from: S, to: S): WorkflowBuilder<S> {
    for (const stage of [from, to]) {
      if (!this.nodes.some((n) => n.stage === stage)) {
        throw new Error(`阶段 ${stage} 还没声明，连不了 ${from} → ${to} 这条边`);
      }
    }
    const node = this.nodes.find((n) => n.stage === from)!;
    if (!node.next.includes(to)) node.next.push(to);
    return this;
  }

  /** 收口。顺便体检一遍，接错线在启动时就炸，而不是等任务走到那儿。 */
  build(): Workflow<S> {
    const known = new Set(this.nodes.map((n) => n.stage));
    for (const node of this.nodes) {
      for (const to of node.next) {
        if (!known.has(to)) {
          throw new Error(`${node.stage} → ${to}：目标阶段不存在`);
        }
      }
      // 有人认领却无路可走 = 任务会永远停在这；没人认领却还有出边 = 没人推得动它
      if (node.owner && !node.next.length) {
        throw new Error(`${node.stage} 有人认领（${node.owner}）却是死路`);
      }
      if (!node.owner && node.next.length) {
        throw new Error(`${node.stage} 没人认领却还有出边，谁来推进？`);
      }
    }
    return new Workflow(this.nodes as Node<S>[]);
  }
}

/** 建好的流程。只读，运行期靠它查认领和校验流转。 */
export class Workflow<S extends string> {
  constructor(private readonly nodes: Node<S>[]) {}

  get stages(): S[] {
    return this.nodes.map((n) => n.stage);
  }

  /** 这个阶段归谁。各 agent 拿它判断「这条消息是不是我的活」。 */
  ownerOf(stage: S): AgentJob | null {
    return this.at(stage).owner;
  }

  /**
   * 校验一次流转，返回目标阶段。
   *
   * 图里没有的边直接抛——流程接错属于开发期的错，早炸比让任务悄悄卡死强。
   */
  advance(from: S, to: S): S {
    const node = this.at(from);
    if (!node.next.includes(to)) {
      throw new Error(
        `流程里没有 ${from} → ${to} 这条边（${from} 只能去：${node.next.join(" / ") || "无，已是终点"}）`,
      );
    }
    return to;
  }

  /** 启动时打出来看一眼，省得改了声明忘了改注释里的图 */
  describe(): string {
    return this.nodes
      .map((n) => {
        const who = n.owner ? JOB_SHORT[n.owner] : "—";
        const to = n.next.length ? n.next.join(" / ") : "终点";
        return `  ${n.stage.padEnd(11)} ${n.label.padEnd(5)} ${who.padEnd(5)} → ${to}`;
      })
      .join("\n");
  }

  private at(stage: S): Node<S> {
    const node = this.nodes.find((n) => n.stage === stage);
    if (!node) throw new Error(`流程里没有 ${stage} 这个阶段`);
    return node;
  }
}

const JOB_SHORT: Record<AgentJob, string> = {
  triage: "话题",
  product: "产品",
  dev: "研发",
  review: "审查",
};

export const workflow = new WorkflowBuilder()
  .next("clarifying", "triage", "澄清需求")
  .next("spec", "product", "拆解需求")
  .next("coding", "dev", "写代码")
  .next("review", "review", "代码审查")
  .next("accepting", "product", "验收")
  .next("done", null, "完成")
  .edge("review", "coding") // 审查不通过，打回重改
  .edge("accepting", "coding") // 还有下一步，再来一轮
  .build();

export type Stage = (typeof workflow)["stages"][number];

/** 落盘校验用。阶段名只在上面那串链里写一次，这里跟着走。 */
export const StageSchema = z.enum(workflow.stages as [Stage, ...Stage[]]);
