import type { RouteLabel } from "./schema.js";

/**
 * 规则匹配
 * 
 * 命中即返回，所以顺序是有含义的：COMPLEX 一组排在前面。
 * 「重构一下这个模块，谢谢」得先被 dev-intent 拿走，不能让末尾那声谢谢
 * 把它变成寒暄。
 */
export interface Rule {
  readonly name: string;
  readonly label: RouteLabel;
  test(text: string): boolean;
}

/** 超过这个长度基本不可能是寒暄，愿意花口舌说这么多的都是正事 */
const LONG_TEXT = 120;

/** 动手改东西的动词。命中一个就当需求，宁可多开一个话题。 */
const DEV_INTENT =
  /新增|增加|加个|加一个|添加|实现|开发|做一个|做个|搭一个|重构|重写|迁移|拆分|优化|修复|修一下|修下|解决|改成|改一下|改下|调整|去掉|删掉|移除|下线|支持|接入|对接|兼容|升级|替换|报错|异常|崩溃|白屏|卡死|不生效|没反应|复现|上线|部署|回滚|灰度|埋点|监控|告警|单测|测试用例|性能|内存泄漏|接口|需求|bug|issue|fix|refactor|feature/i;

/** 代码块、文件路径、链接——出现这些就是在指着具体的东西说话 */
const CODE_REF =
  /```|(^|[\s(（])(src|lib|packages|app|components)\/|[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|json|py|go|java|rs|rb|php|c|cpp|h|vue|css|scss|less|html|sql|ya?ml|md)\b|https?:\/\//i;

/** 整条就是一句寒暄 */
const GREETING =
  /^(你好|您好|哈喽|哈啰|嗨|hi|hello|hey|yo|在吗|在么|在不在|早|早安|早上好|中午好|下午好|晚上好|晚安)[\s!！。.~～?？、]*$/i;

/** 整条就是一句客套或者应答 */
const COURTESY =
  /^(谢谢|谢啦|多谢|感谢|辛苦|辛苦了|麻烦了|好的|好嘞|好呀|收到|明白|懂了|知道了|了解|ok|okay|okk|嗯+|哦+|行|可以|没问题|不用了|算了)[\s!！。.~～]*$/i;

/** 一个表情、一个标点，没有任何实词 */
const NO_WORDS = /^[^\p{L}\p{N}]+$/u;

/** 问团队本身：你是谁、能干嘛、怎么用、现在做到哪了 */
const ABOUT_TEAM =
  /^.{0,30}(你是谁|你叫什么|你能做什么|你能干什么|你能干嘛|能帮我做什么|有什么功能|怎么用|咋用|如何使用|使用说明|使用方式|帮助|help|进度|到哪了|做完了吗|做完了没|好了吗|好了没|在干嘛|在忙什么).{0,30}$/i;

export const RULES: readonly Rule[] = [
  {
    name: "code-ref",
    label: "COMPLEX",
    test: (text) => CODE_REF.test(text),
  },
  {
    name: "long-text",
    label: "COMPLEX",
    test: (text) => text.length > LONG_TEXT,
  },
  {
    name: "dev-intent",
    label: "COMPLEX",
    test: (text) => DEV_INTENT.test(text),
  },
  {
    name: "greeting",
    label: "SIMPLE",
    test: (text) => GREETING.test(text),
  },
  {
    name: "courtesy",
    label: "SIMPLE",
    test: (text) => COURTESY.test(text),
  },
  {
    name: "no-words",
    label: "SIMPLE",
    test: (text) => NO_WORDS.test(text),
  },
  {
    name: "about-team",
    label: "SIMPLE",
    test: (text) => ABOUT_TEAM.test(text),
  },
];

export function matchRule(text: string): Rule | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return RULES.find((rule) => rule.test(trimmed)) ?? null;
}
