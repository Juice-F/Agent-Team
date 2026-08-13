import type { Agent, AgentJob, WorkflowStage } from "../types.js";
import { WorkflowStageSchema } from "../schema.js";

export interface Node {
  readonly stage: WorkflowStage;
  readonly label: string;
  readonly agent: Agent | null;
  readonly next: WorkflowStage[];
}

export class WorkflowBuilder {
  private readonly nodes: Node[] = [];

  constructor(private readonly agents: Record<AgentJob, Agent>) {}

  next(stage: WorkflowStage, job: AgentJob, label: string): this {
    return this.push(stage, this.agents[job], label);
  }

  end(stage: WorkflowStage, label: string): this {
    return this.push(stage, null, label);
  }

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

  build(): Workflow {
    for (const stage of Object.keys(WorkflowStageSchema)) {
      if (!this.nodes.some((n) => n.stage === stage)) {
        throw new Error(`阶段 ${stage} 声明了交接单，却没接进流程`);
      }
    }
    for (const node of this.nodes) {
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

  private push(
    stage: WorkflowStage,
    agent: Agent | null,
    label: string
  ): this {
    if (this.nodes.some((n) => n.stage === stage)) {
      throw new Error(`阶段 ${stage} 接了两次`);
    }
    this.nodes.at(-1)?.next.push(stage);
    this.nodes.push({ stage, agent, label, next: [] });
    return this;
  }
}

export class Workflow {
  constructor(
    private readonly nodes: Node[],
    readonly agents: Agent[],
  ) {}

  ownerOf(stage: WorkflowStage): AgentJob | null {
    return this.at(stage).agent?.job ?? null;
  }

  advance(from: WorkflowStage, to: WorkflowStage): WorkflowStage {
    const node = this.at(from);
    if (!node.next.includes(to)) {
      throw new Error(
        `流程里没有 ${from} → ${to} 这条边（${from} 只能去：${node.next.join(" / ") || "无，已是终点"}）`,
      );
    }
    return to;
  }

  at(stage: WorkflowStage): Node {
    const node = this.nodes.find((n) => n.stage === stage);
    if (!node) throw new Error(`流程里没有 ${stage} 这个阶段`);
    return node;
  }
}
