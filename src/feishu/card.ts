export interface Card {
  schema: "2.0";
  config?: Record<string, unknown>;
  header?: Record<string, unknown>;
  body: { elements: Record<string, unknown>[] };
}

export type CardTone = "progress" | "done" | "info" | "error" | "task";

const TONE_TEMPLATE: Record<CardTone, string> = {
  progress: "blue",
  done: "green",
  info: "wathet",
  error: "red",
  task: "indigo",
};

const TONE_ICON: Record<CardTone, string> = {
  progress: "⏳",
  done: "✅",
  info: "💬",
  error: "⚠️",
  task: "🆕",
};

export interface CardButton {
  text: string;
  value: Record<string, unknown>;
  primary?: boolean;
}

/** 表单里的一行输入 */
export interface CardField {
  /** 组件名。用户填的值按这个名字回传，见 CardAction.formValue */
  name: string;
  label: string;
  /** 预填进去的内容，用户可以改 */
  initial?: string;
  placeholder?: string;
}

/**
 * 要用户填几项、填完一起提交的表单。
 *
 * 和 buttons 的区别在回传的东西：按钮只带得回自己 value 里写死的参数，表单还会
 * 把用户填的值按组件名一起带回来。
 */
export interface CardForm {
  fields: CardField[];
  submit: CardButton;
}

export interface CardInput {
  tone: CardTone;
  title: string;
  subtitle?: string;
  /**
   * 用户原文之类不可信的文本。走 plain_text 而不是 markdown——里面的 * ` #
   * 会把卡片渲染搞坏。
   */
  quote?: string;
  quoteLabel?: string;
  /**
   * 正文上面单独一段，和正文之间隔一条分割线。
   *
   * 给「这条卡片为什么现在出现」这类话用——比如助手刚说的那句、或者上次填错在
   * 哪儿。和正文分层摆，人一眼看得出哪句是冲着这一次说的、哪段是每次都一样的。
   */
  lead?: string;
  /** 我们自己写的正文，markdown */
  body?: string;
  /** 折叠面板里的长内容，比如思考链 */
  detail?: string;
  detailLabel?: string;
  /** 要用户点一下才能定下来的选项 */
  buttons?: CardButton[];
  /** 要用户填几项再提交的表单 */
  form?: CardForm;
  /** 底部小字 */
  note?: string;
}

/** 表单也算：它里面那个提交按钮同样只该点一次 */
function interactive(element: Record<string, unknown>): boolean {
  return element["tag"] === "button" || element["tag"] === "form";
}

export function hasButtons(card: Card): boolean {
  return card.body.elements.some(interactive);
}

export function settleCard(card: Card, chosen: string): Card {
  const elements: Record<string, unknown>[] = [];
  let settled = false;
  for (const element of card.body.elements) {
    if (!interactive(element)) {
      elements.push(element);
      continue;
    }
    // 一排按钮合成一行，不是每个按钮各换一行
    if (settled) continue;
    settled = true;
    elements.push({ tag: "markdown", content: `**已选择：${chosen}**` });
  }
  return { ...card, body: { elements } };
}

function buttonOf(button: CardButton, submit = false): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: button.text },
    type: button.primary ? "primary" : "default",
    // callback 才会走事件回调回到进程里；url 之类的行为这儿用不上
    behaviors: [{ type: "callback", value: button.value }],
    // 提交按钮要有名字，飞书按它把整个表单的值收上来
    ...(submit && { name: "submit", form_action_type: "submit" }),
  };
}

function fieldOf(field: CardField): Record<string, unknown> {
  return {
    tag: "input",
    name: field.name,
    label: { tag: "plain_text", content: field.label },
    ...(field.placeholder && {
      placeholder: { tag: "plain_text", content: field.placeholder },
    }),
    ...(field.initial && { default_value: field.initial }),
  };
}

export function generateCard(input: CardInput): Card {
  const sections: Record<string, unknown>[][] = [];

  if (input.lead) {
    sections.push([{ tag: "markdown", content: input.lead }]);
  }
  if (input.quote) {
    const quote: Record<string, unknown>[] = [];
    if (input.quoteLabel) {
      quote.push({ tag: "markdown", content: `**${input.quoteLabel}**` });
    }
    quote.push({ tag: "div", text: { tag: "plain_text", content: input.quote } });
    sections.push(quote);
  }
  if (input.body) {
    sections.push([{ tag: "markdown", content: input.body }]);
  }
  if (input.detail) {
    sections.push([
      {
        tag: "collapsible_panel",
        expanded: false,
        header: {
          title: {
            tag: "markdown",
            content: input.detailLabel ?? "查看思考过程",
          },
        },
        elements: [{ tag: "markdown", content: input.detail }],
      },
    ]);
  }
  if (input.buttons?.length) {
    // 2.0 把 action 那个容器去掉了，按钮直接就是 body 里的一级元素，一个一行
    sections.push(input.buttons.map((button) => buttonOf(button)));
  }
  if (input.form) {
    // 输入框和提交按钮都得在 form 里面——按钮在外面的话，点它带不回填的值
    sections.push([
      {
        tag: "form",
        name: "form",
        elements: [
          ...input.form.fields.map(fieldOf),
          buttonOf(input.form.submit, true),
        ],
      },
    ]);
  }
  if (input.note) {
    sections.push([{ tag: "markdown", content: `*${input.note}*` }]);
  }

  const elements = sections.flatMap((section, i) =>
    i === 0 ? section : [{ tag: "hr" }, ...section],
  );
  // body.elements 空数组会被飞书拒掉，兜一个占位
  if (!elements.length) elements.push({ tag: "markdown", content: " " });

  const header: Record<string, unknown> = {
    template: TONE_TEMPLATE[input.tone],
    title: {
      tag: "plain_text",
      content: `${TONE_ICON[input.tone]} ${input.title}`,
    },
  };
  if (input.subtitle) {
    header["subtitle"] = { tag: "plain_text", content: input.subtitle };
  }

  return { schema: "2.0", header, body: { elements } };
}
