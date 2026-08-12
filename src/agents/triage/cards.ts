import { generateCard, type Card, type CardButton } from "../../feishu/card.js";
import type { CardChoice } from "../../schema.js";
import type { Session, TaskRepo } from "../../session/index.js";
import { repoLabel, type RepoProblem } from "../../workspace/index.js";

const HOW_TO = [
  "在哪个仓库上做？本地路径 或者 git 地址都行。",
  "",
  "点确认之后我把代码拉一份到这个任务自己的工作区。",
].join("\n");

/** 挂在按钮上的东西。stage 写死 clarifying：这几张卡片只在澄清那一棒发。 */
function choice(task: Session, text: string): CardButton["value"] {
  return {
    threadId: task.threadId,
    stage: "clarifying",
    text,
    confirm: true,
  } satisfies CardChoice;
}

export function thinking(detail?: string): Card {
  return generateCard({ tone: "progress", title: "思考中", detail });
}

export function failed(): Card {
  return generateCard({
    tone: "error",
    title: "没判断出来",
    body: "再说一次试试",
  });
}

export function replied(reply: string): Card {
  return generateCard({ tone: "info", title: "已回复", body: reply });
}

export function threadOpened(): Card {
  return generateCard({
    tone: "info",
    title: "已开话题",
    note: "在话题里直接回就行，不用再 @ 我",
  });
}

export function alreadyFiled(): Card {
  return generateCard({
    tone: "info",
    title: "这次对话已经立过项了",
    note: "去那个话题里接着说；要提新需求，在群里 @话题助手 重新立项",
  });
}

export function threadUnsupported(): Card {
  return generateCard({
    tone: "error",
    title: "无法开启话题",
    body: "多任务并行需要话题支持，请把机器人拉进支持话题的群，或联系管理员。",
  });
}

export function filed(task: Session): Card {
  return generateCard({
    tone: "done",
    title: "已立项",
    subtitle: task.id,
    body: `「${task.title}」已经开了话题，在话题里填好仓库就交给产品经理`,
  });
}

export function handOff(task: Session): Card {
  const where = task.repo ? `\n\n代码在 **${repoLabel(task.repo)}**。` : "";
  return generateCard({
    tone: "task",
    title: task.title,
    subtitle: "话题助手 → 产品经理",
    quoteLabel: "需求",
    quote: task.request,
    body: `这个需求后续都由产品经理跟进。**后续讨论都在这个话题里回复**，不用再 @ 我。${where}`,
    note: `任务 ${task.id} · 多个话题可以同时进行`,
  });
}

export function pickRepo(
  task: Session,
  opts: {
    /** 开头那句因情况而异的话 */
    why?: string;
    /** 上次填的哪儿不对。有它这张就是报错卡 */
    problem?: RepoProblem;
    /** 预填。默认填上这个任务已经记着的那份 */
    prefill?: TaskRepo | null;
  } = {},
): Card {
  const initial = (opts.prefill ?? task.repo)?.source ?? "";
  const lead = opts.problem?.hint ?? opts.why;

  return generateCard({
    tone: opts.problem ? "error" : "task",
    title: opts.problem?.title ?? "填仓库",
    subtitle: task.id,
    ...(lead && { lead }),
    body: HOW_TO,
    ...(opts.problem?.detail && {
      detail: opts.problem.detail,
      detailLabel: "查看 git 的报错",
    }),
    form: {
      fields: [
        {
          name: "source",
          label: "仓库",
          placeholder: "本地路径或 git 地址",
          ...(initial && { initial }),
        },
      ],
      submit: { text: "确认", value: choice(task, "确认"), primary: true },
    },
    note: `任务 ${task.id} · 需求可以同时在话题里接着聊`,
  });
}

/**
 * 话题里的第一张卡片。
 *
 * 开话题这一刻还没有 threadId，按钮的 value 挂不上，所以填仓库那张只能等落盘之后
 * 再 patch 上来——需求当场就问清楚了才会走到那一步，没问清楚的就停在这张上接着聊。
 */
export function opening(reply: string): Card {
  return generateCard({
    tone: "task",
    title: "已开话题",
    body: reply,
    note: "在话题里直接回就行，不用再 @ 我",
  });
}
