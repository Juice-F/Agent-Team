import { generateCard, type Card } from "../../feishu/card.js";
import type { Task } from "../../store/index.js";

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

export function threadUnsupported(): Card {
  return generateCard({
    tone: "error",
    title: "无法开启话题",
    body: "多任务并行需要话题支持，请把机器人拉进支持话题的群，或联系管理员。",
  });
}

export function filed(task: Task): Card {
  return generateCard({
    tone: "done",
    title: "已立项",
    subtitle: task.id,
    body: `「${task.title}」交给产品经理跟进`,
  });
}

export function handOff(task: Task): Card {
  return generateCard({
    tone: "task",
    title: task.title,
    subtitle: "话题助手 → 产品经理",
    quoteLabel: "需求",
    // 用户原文可能带 markdown 字符，quote 会走 plain_text
    quote: task.request,
    body: "这个需求后续都由产品经理跟进。**后续讨论都在这个话题里回复**，不用再 @ 我。",
    note: `任务 ${task.id} · 多个话题可以同时进行`,
  });
}
