// 轻量 i18n：语言包 JSON + t(key, params) + locale 格式化函数。
// 规则：代码与 HTML 中不留任何硬编码中文；键按语义命名；数字/货币/日期一律走本模块，不拼字符串。

const LOCALE_TAGS = { zh: "zh-CN", es: "es-MX", en: "en-US" };
export const LANGS = ["zh", "es", "en"];
const FALLBACK = "zh"; // 中文是母本：规则文案先在中文定稿，再逐块翻译

let current = "zh";
let messages = {};
let fallbackMessages = {};
const missing = new Set();   // 本次会话遇到的缺译键，供 i18n 状态脚本与控制台排查

export async function initI18n(lang = "zh") {
  current = LANGS.includes(lang) ? lang : FALLBACK;
  const load = (l) => fetch(`src/i18n/${l}.json`).then((x) => x.json()).catch(() => ({}));
  [messages, fallbackMessages] = current === FALLBACK
    ? await Promise.all([load(FALLBACK), Promise.resolve({})])
    : await Promise.all([load(current), load(FALLBACK)]);
  missing.clear();
}

/**
 * 取文案。缺译时回退到中文母本（而不是显示键名）——三语可以增量推进：
 * 翻好的用目标语言，没翻的仍显示中文，页面不会出现 raw key。
 * 缺译键记入 missing 并在控制台提示，配合 scripts/i18n_status.js 查覆盖率。
 */
export function t(key, params = {}) {
  let s = messages[key];
  if (s === undefined) {
    s = fallbackMessages[key];
    if (s !== undefined && !missing.has(key)) {
      missing.add(key);
      console.warn(`[i18n] 缺 ${current} 译文，回退中文：${key}`);
    }
  }
  if (s === undefined) return key; // 中英西都没有 → 显示键名，说明是真漏配
  for (const [k, v] of Object.entries(params)) {
    s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/** 本次渲染中缺译的键（调试用） */
export function missingKeys() {
  return [...missing];
}

export function hasKey(key) {
  return messages[key] !== undefined;
}

const tag = () => LOCALE_TAGS[current] ?? "zh-CN";

/**
 * 指标单位。单位是规则数据的一部分，但要跟着界面语言变——
 * 声明了 unit_key 的走语言包（如「完美单/日」），没声明的直接用 unit 字面值（如 '%'，三语通用）。
 * 视图一律用本函数取单位，不要直接读 rule.unit，否则英/西版会夹中文。
 */
export function tUnit(rule) {
  if (!rule) return "";
  return rule.unit_key ? t(rule.unit_key) : (rule.unit ?? "");
}

export function fmtNumber(n, opts = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return t("common.na");
  return new Intl.NumberFormat(tag(), opts).format(n);
}

export function fmtPoints(n) {
  return fmtNumber(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function fmtCurrency(n, currency) {
  return new Intl.NumberFormat(tag(), {
    style: "currency", currency, maximumFractionDigits: 0,
  }).format(n);
}

export function fmtPercentValue(n) {
  // 数据源中的百分数是已乘 100 的数值（如 93.3），此处只做数字格式化并追加 %
  return `${fmtNumber(n, { maximumFractionDigits: 1 })}%`;
}

export function fmtMonth(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return new Intl.DateTimeFormat(tag(), { year: "numeric", month: "long" })
    .format(new Date(Number(m[1]), Number(m[2]) - 1, 1));
}

export function currentLang() {
  return current;
}
