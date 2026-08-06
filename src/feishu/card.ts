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
  /** 我们自己写的正文，markdown */
  body?: string;
  /** 折叠面板里的长内容，比如思考链 */
  detail?: string;
  detailLabel?: string;
  /** 底部小字 */
  note?: string;
}

export function generateCard(input: CardInput): Card {
  const sections: Record<string, unknown>[][] = [];

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
