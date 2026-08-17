/** 毫秒 → 人看的。分钟以上就别再显示毫秒了 */
export function dur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${String(sec).padStart(2, "0")}s`;
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 单次调用常常是几厘钱，两位小数全是 $0.00，看不出差别 */
export function usd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

/**
 * 终端里占几格。
 *
 * 不能用 text.length：中文和全角标点一个字符占两格，按字符数补空格的话，
 * 中文表头和底下的英文数据永远对不齐。
 */
function cells(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0x303e) ||
      (c >= 0x3041 && c <= 0x33ff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xa000 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    n += wide ? 2 : 1;
  }
  return n;
}

export function pad(text: string, width: number): string {
  const w = cells(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

/** 直方图排个序，多的在前，太长就收尾 */
export function histogram(tools: Record<string, number>, top = 6): string {
  const entries = Object.entries(tools).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "";

  const shown = entries.slice(0, top).map(([name, n]) => `${name}×${n}`);
  const rest = entries.length - shown.length;
  return shown.join(" ") + (rest > 0 ? ` +${rest} 种` : "");
}
