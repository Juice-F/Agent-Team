import { generateCard, type Card } from "../../feishu/card.js";
import type { Session } from "../../session/index.js";
import type { CardChoice } from "../../schema.js";
import type { ReviewOutput } from "./schema.js";

export function reviewing(detail?: string): Card {
  return generateCard({
    tone: "progress",
    title: "审查中",
    detail,
    detailLabel: "查看进展",
  });
}

export function failed(): Card {
  return generateCard({
    tone: "error",
    title: "这一轮没审完",
    body: "在话题里说一句，我重新看一遍",
  });
}

export function passed(task: Session, out: ReviewOutput): Card {
  return generateCard({
    tone: "done",
    title: "审查通过",
    subtitle: task.id,
    body: out.summary,
    note: "交给产品验收",
  });
}

/**
 * 没过。列出问题，等人点一下才真的打回。
 *
 * 不自动返工是有意的：dev → review 是条环路，让它自己转起来，一个判错的
 * reject 就能拉着两个模型一直烧下去，中间没人看得见。
 */
export function rejected(task: Session, out: ReviewOutput): Card {
  const list = out.issues
    .map((i) => (i.file ? `- \`${i.file}\`：${i.detail}` : `- ${i.detail}`))
    .join("\n");

  return generateCard({
    tone: "error",
    title: "审查没通过",
    subtitle: task.id,
    body: `${out.summary}\n\n**要改的地方**\n${list}`,
    buttons: [
      {
        text: "打回返工",
        value: {
          threadId: task.threadId,
          stage: "review",
          text: "确认打回，让研发按意见返工",
          confirm: true,
        } satisfies CardChoice,
        primary: true,
      },
    ],
    note: "不点就停在这儿。觉得判错了，直接在话题里说",
  });
}

export function sentBack(task: Session): Card {
  return generateCard({
    tone: "task",
    title: "已打回返工",
    subtitle: task.id,
    body: `「${task.title}」按审查意见交回研发重改。`,
  });
}
