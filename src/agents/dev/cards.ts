import { generateCard, type Card } from "../../feishu/card.js";
import type { Session } from "../../session/index.js";
import type { DevOutput } from "./schema.js";

export function working(detail?: string): Card {
  return generateCard({
    tone: "progress",
    title: "写代码中",
    detail,
    detailLabel: "查看进展",
  });
}

export function failed(): Card {
  return generateCard({
    tone: "error",
    title: "这一轮没写完",
    body: "在话题里说一句，我重新跑一遍",
  });
}

/** 跑完了。改动本身在仓库里，这张卡片只交代动了哪儿、验到什么程度。 */
export function done(task: Session, out: DevOutput): Card {
  const sections = [out.summary, `**自查**\n${out.verified}`];
  if (out.changed.length) {
    sections.push(
      `**动过的文件**\n${out.changed.map((f) => `- \`${f}\``).join("\n")}`,
    );
  }
  if (out.concerns.length) {
    sections.push(
      `**待确认**\n${out.concerns.map((c) => `- ${c}`).join("\n")}`,
    );
  }

  return generateCard({
    tone: "done",
    title: "代码已提交审查",
    subtitle: task.id,
    body: sections.join("\n\n"),
    note: "改动留在工作区没有提交，交给代码审查看",
  });
}
