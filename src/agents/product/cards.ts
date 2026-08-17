import { generateCard, type Card, type CardButton } from "../../feishu/card.js";
import type { Session } from "../../postgres/session.js";
import type { CardChoice } from "../../schema.js";
import type { AcceptOutput, ProductOutput } from "./schema.js";

/** 挂在按钮上的东西。stage 写死 spec：这几张卡片只在拆解那一棒发。 */
function choice(task: Session, text: string, confirm = false): CardButton["value"] {
  return {
    threadId: task.threadId,
    stage: "spec",
    text,
    confirm,
  } satisfies CardChoice;
}

/** 验收那一棒的按钮。收工和打回都是「确认」，走哪条看 acceptNote 空不空。 */
function acceptChoice(task: Session, text: string): CardButton["value"] {
  return {
    threadId: task.threadId,
    stage: "accepting",
    text,
    confirm: true,
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

export function checking(detail?: string): Card {
  return generateCard({
    tone: "progress",
    title: "验收中",
    detail,
    detailLabel: "查看进展",
  });
}

export function checkFailed(): Card {
  return generateCard({
    tone: "error",
    title: "没验完",
    body: "在话题里说一句，我重新看一遍",
  });
}

/** 验收通过，等用户点头收工。最后拍板的是人，不是产品。 */
export function checked(task: Session, out: AcceptOutput): Card {
  return generateCard({
    tone: "done",
    title: "验收通过",
    subtitle: task.id,
    body: out.summary,
    buttons: [
      { text: "收工", value: acceptChoice(task, "验收通过，收工"), primary: true },
    ],
    note: "还有没做到的地方，直接在话题里说",
  });
}

/**
 * 验收没过。
 *
 * 同样要人点一下——打回一轮是产品重拆、研发重写、审查重看整整一圈，不该由模型
 * 自己决定要不要再烧一遍。
 */
export function unchecked(task: Session, out: AcceptOutput): Card {
  const list = out.gaps.map((g) => `- ${g}`).join("\n");
  return generateCard({
    tone: "error",
    title: "验收没通过",
    subtitle: task.id,
    body: `${out.summary}\n\n**没做到的**\n${list}`,
    buttons: [
      {
        text: "打回重做",
        value: acceptChoice(task, "验收不通过，回去重新拆一遍"),
        primary: true,
      },
    ],
    note: "不点就停在这儿。觉得判严了，直接在话题里说",
  });
}

export function finished(task: Session): Card {
  return generateCard({
    tone: "done",
    title: "任务完成",
    subtitle: task.id,
    body: `「${task.title}」到此为止。`,
  });
}

export function reopened(task: Session): Card {
  return generateCard({
    tone: "task",
    title: "打回重做",
    subtitle: task.id,
    body: `「${task.title}」按验收意见回到需求拆解，重新走一遍。`,
  });
}
