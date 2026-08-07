import type { AgentJob, WorkflowStage } from "../type.js";
import { WorkflowStageSchema } from "../schema.js";
import type { AnyAgent } from "./types.js";
import { Runner, type TaskStore } from "./runner.js";

/**
 * 流程的图：谁认领哪一棒、能往哪走。
 *
 * 有哪些阶段、各自收什么，在 schema.ts 的 WorkflowStageSchema；谁来干、干什么，是构造时传
 * 进来的那些 agent。这里把两边接成一张图，接错在启动时就炸，不用等任务走到那儿
 * 才发现。
 */

export interface Node {
  readonly stage: WorkflowStage;
  readonly label: string;
  /** 谁在这个节点干活。终点没人认领。 */
  readonly agent: AnyAgent | null;
  readonly next: WorkflowStage[];
}

/** 从 agent 身上把「认领哪几棒」抠出来 */
type Handled<T> = T extends { readonly handles: readonly (infer S)[] } ? S : never;

/** 谁能认领 N 这一棒 —— 只有 handles 里有它的那些角色 */
type OwnerOf<A, N extends WorkflowStage> = {
  [J in keyof A]: N extends Handled<A[J]> ? J : never;
}[keyof A];

/**
 * 流程的构造器。
 *
 * `.next()` 按顺序声明主干，前后自动连边；`.edge()` 补主干表达不了的那些——打回、
 * 返工、跳步。分成两个方法是因为流程不是一条直线：审查和研发之间有环，验收之后
 * 还能再来一轮，链式调用只能往前走，环得单独说。
 *
 * 阶段名只认 WorkflowStageSchema 里有的，认领人只认真的实现了那一棒的 agent，两样都是编译期
 * 检查。表里声明了却没接进链的阶段，build() 会炸。
 */
export class WorkflowBuilder<A extends Record<AgentJob, AnyAgent>> {
  private readonly nodes: Node[] = [];

  /** @param agents 全部角色。接线时按名字挑，`run()` 时统一拉起来。 */
  constructor(private readonly agents: A) {}

  /** 接一个有人认领的阶段到主干末尾，自动从上一个阶段连一条边过来。 */
  next<N extends WorkflowStage, J extends OwnerOf<A, N> & AgentJob>(
    stage: N,
    job: J,
    label: string,
  ): this {
    return this.push(stage, this.agents[job], label);
  }

  /** 终点。没人认领，也就没有活要干。 */
  end(stage: WorkflowStage, label: string): this {
    return this.push(stage, null, label);
  }

  /** 主干之外的边：打回、返工、跳步。两端都必须是已经接过的阶段。 */
  edge(from: WorkflowStage, to: WorkflowStage): this {
    for (const stage of [from, to]) {
      if (!this.nodes.some((n) => n.stage === stage)) {
        throw new Error(`阶段 ${stage} 还没接进流程，连不了 ${from} → ${to} 这条边`);
      }
    }
    const node = this.nodes.find((n) => n.stage === from)!;
    if (!node.next.includes(to)) node.next.push(to);
    return this;
  }

  /** 收口。顺便体检一遍，接错线在启动时就炸，而不是等任务走到那儿。 */
  build(): Workflow {
    // 交接单表里有、链上却没接的阶段：加了新阶段忘了接线，最容易漏在这
    for (const stage of Object.keys(WorkflowStageSchema)) {
      if (!this.nodes.some((n) => n.stage === stage)) {
        throw new Error(`阶段 ${stage} 声明了交接单，却没接进流程`);
      }
    }
    for (const node of this.nodes) {
      // 有人认领却无路可走 = 任务会永远停在这；没人认领却还有出边 = 没人推得动它
      if (node.agent && !node.next.length) {
        throw new Error(`${node.stage} 有人认领（${node.agent.job}）却是死路`);
      }
      if (!node.agent && node.next.length) {
        throw new Error(`${node.stage} 没人认领却还有出边，谁来推进？`);
      }
      // 类型那层已经对过一遍；这里再对一次运行期的真相，省得 as 之类的把它绕过去
      if (node.agent && !node.agent.handles.includes(node.stage)) {
        throw new Error(
          `${node.stage} 派给了 ${node.agent.job}，但它只认领 ${node.agent.handles.join(" / ")}`,
        );
      }
    }
    return new Workflow(this.nodes, Object.values(this.agents));
  }

  private push(stage: WorkflowStage, agent: AnyAgent | null, label: string): this {
    if (this.nodes.some((n) => n.stage === stage)) {
      throw new Error(`阶段 ${stage} 接了两次`);
    }
    this.nodes.at(-1)?.next.push(stage);
    this.nodes.push({ stage, agent, label, next: [] });
    return this;
  }
}

/** 建好的流程。`run()` 把角色都拉起来，之后就等消息推着它走。 */
export class Workflow {
  constructor(
    private readonly nodes: Node[],
    readonly agents: readonly AnyAgent[],
  ) {}

  get stages(): WorkflowStage[] {
    return this.nodes.map((n) => n.stage);
  }

  /** 这个阶段归谁。引擎拿它判断「这条消息是不是这个角色的活」。 */
  ownerOf(stage: WorkflowStage): AgentJob | null {
    return this.at(stage).agent?.job ?? null;
  }

  /**
   * 校验一次流转，返回目标阶段。
   *
   * 图里没有的边直接抛——流程接错属于开发期的错，早炸比让任务悄悄卡死强。
   */
  advance(from: WorkflowStage, to: WorkflowStage): WorkflowStage {
    const node = this.at(from);
    if (!node.next.includes(to)) {
      throw new Error(
        `流程里没有 ${from} → ${to} 这条边（${from} 只能去：${node.next.join(" / ") || "无，已是终点"}）`,
      );
    }
    return to;
  }

  /**
   * 跑起来：把所有角色的服务拉起来，把中断在半路的任务捡回来，然后等消息。
   *
   * 返回引擎本身，外面拿它做收尾（比如退出前 interruptAll）。
   */
  async run(store: TaskStore): Promise<Runner> {
    const runner = new Runner(this, store);
    await runner.start();
    return runner;
  }

  /** @internal 引擎要拿认领人 */
  at(stage: WorkflowStage): Node {
    const node = this.nodes.find((n) => n.stage === stage);
    if (!node) throw new Error(`流程里没有 ${stage} 这个阶段`);
    return node;
  }
}
