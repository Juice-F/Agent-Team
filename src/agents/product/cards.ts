import { generateCard, type Card, type CardButton } from "../../feishu/card.js";
import type { Session } from "../../store/index.js";
import type { CardChoice } from "../../schema.js";
import type { ProductOutput } from "./schema.js";

/** 挂在按钮上的东西。stage 写死 spec：这几张卡片只在拆解那一棒发。 */
function choice(task: Session, text: string, confirm = false): CardButton["value"] {
  return {
    threadId: task.threadId,
    stage: "spec",
    text,
    confirm,
  } satisfies CardChoice;
}

export function thinking(detail?: string): Card {
  return generateCard({ tone: "progress", title: "拆解中", detail });
}

export function failed(): Card {
  return generateCard({
    tone: "error",
    title: "没拆出来",
    body: "在话题里说一句，我重新拆一遍",
  });
}

/** 要用户拍板的那一个点。选项做成按钮，也允许直接打字答。 */
export function asking(task: Session, out: ProductOutput): Card {
  return generateCard({
    tone: "info",
    title: out.question,
    subtitle: task.id,
    body: out.reply,
    buttons: out.options.map((option) => ({
      text: option,
      value: choice(task, option),
    })),
    note: "选项不合适的话，直接在话题里说你想要的",
  });
}

/**
 * 方案初稿，等确认。
 *
 * 只给一个「确认」按钮，不给「再改改」——点了再改改还是得说改哪儿，等于白点
 * 一下，不如直接在话题里说。
 */
export function drafted(task: Session, out: ProductOutput): Card {
  return generateCard({
    tone: "task",
    title: "方案初稿",
    subtitle: task.id,
    body: `${out.reply}\n\n---\n\n${out.plan}`,
    buttons: [
      {
        text: "就按这个做",
        value: choice(task, "确认方案，可以开工", true),
        primary: true,
      },
    ],
    note: "要改的地方直接在话题里说，我改完再发一版",
  });
}

export function handOff(task: Session): Card {
  return generateCard({
    tone: "done",
    title: "方案已确认",
    subtitle: task.id,
    body: `「${task.title}」交给研发按方案开工。`,
    note: `任务 ${task.id}`,
  });
}
