// 全站渲染自检：把每个期次 × 每家商 × 每个页面都渲染一遍，扫描输出里的坏值。
//
// 为什么要有这个脚本：2026-08-14 开会前页面白屏三次，三次都是「规则结构变了、某个视图仍按旧结构取值」——
// 单元测试盯引擎，recalc 盯分数，但没人盯「视图能不能把这份规则渲染出来」。这里补上。
//
// 检出的坏值：NaN / undefined / null 字面量、raw i18n 键（形如 xxx.yyy 单独成文本）、
// 未替换的占位符 {foo}、以及渲染过程抛出的任何异常。
//
// 用法：bun scripts/render_check.js [语言...]   默认 zh es en 三语全跑

import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const DATA = join(ROOT, "data");

// i18n.js 用 fetch("src/i18n/xx.json") 加载语言包（浏览器语义）→ 在 Bun 里改成读盘
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const u = String(url);
  if (!/^https?:/.test(u)) {
    const text = readFileSync(join(ROOT, u.replace(/^\.?\//, "")), "utf-8");
    return new Response(text, { headers: { "content-type": "application/json" } });
  }
  return realFetch(url, ...rest);
};

const { initI18n, t } = await import("../src/i18n.js");
const { renderOverview } = await import("../src/views/overview.js");
const { renderPerformance } = await import("../src/views/performance.js");
const { renderAdvice } = await import("../src/views/advice.js");
const { renderEarnings } = await import("../src/views/earnings.js");
const { renderRules } = await import("../src/views/rules.js");
const { renderBenchmark } = await import("../src/views/benchmark.js");
const { renderPortfolio } = await import("../src/views/portfolio.js");
const { buildRankingStats } = await import("../src/engine/ranking.js");
// 期次对象用 app 自己的归一化函数构造——自检若自己拼 period，就会把「字段名对不上」误报成站点 bug
const { normalizePeriod } = await import("../src/data.js");

const rules = JSON.parse(readFileSync(join(DATA, "rules.json"), "utf-8"));
const profile = JSON.parse(readFileSync(join(DATA, "vendor_profile.json"), "utf-8"));
const rmAssign = JSON.parse(readFileSync(join(DATA, "rm_assignment.json"), "utf-8"));
const periodsIdx = JSON.parse(readFileSync(join(DATA, "periods.json"), "utf-8"));

const profilesByCode = Object.fromEntries(profile.profiles.map((p) => [p.vendor_code, p]));
const rmOf = (code) => profilesByCode[code]?.rm ?? null;

// 汉字。非中文语言的页面里出现汉字 = 漏译（可能是没翻的键，也可能是 rules.json 里的中文字面值
// 被直接渲染，如 2026-08-14 的 unit '完美单/日'）。逐键比覆盖率查不出后者，扫渲染结果才行。
const CJK = /[一-鿿　-〿＀-￯]/;

/** 坏值扫描。返回命中的问题描述数组 */
function scan(html, where, lang) {
  const bad = [];
  const add = (what, sample) => bad.push(`${where} → ${what}${sample ? `：${sample}` : ""}`);
  if (lang !== "zh") {
    // 只看可见文本，避开注释/属性里的中文（视图源码注释不会进 innerHTML，但 title/aria 会——那些也该翻）
    const text = html.replace(/<[^>]*>/g, " ");
    const hit = text.match(new RegExp(`[^\s]{0,20}${CJK.source}+[^\s]{0,20}`));
    if (hit) add("非中文语言里出现中文（漏译）", hit[0].trim());
  }
  if (/\bNaN\b/.test(html)) add("出现 NaN", (html.match(/.{0,60}NaN.{0,40}/) ?? [])[0]);
  if (/\bundefined\b/.test(html)) add("出现 undefined", (html.match(/.{0,60}undefined.{0,40}/) ?? [])[0]);
  // 未替换的占位符：{level} 这种。CSS 花括号不会单独包一个小写单词，误报风险低
  const ph = html.match(/\{[a-z][a-zA-Z0-9_]{1,20}\}/);
  if (ph) add("占位符未替换", ph[0]);
  // raw i18n 键：>key.sub< 形式的纯键文本（缺键时 t() 会原样返回键名）
  const raw = html.match(/>\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,3})\s*</);
  if (raw) add("疑似未配 i18n 键", raw[1]);
  return bad;
}

const langs = process.argv.slice(2).length ? process.argv.slice(2) : ["zh", "es", "en"];
let problems = [];
let rendered = 0;

for (const lang of langs) {
  await initI18n(lang);
  for (const entry of [...(periodsIdx.monthly ?? []), ...(periodsIdx.weekly ?? [])]) {
    const file = entry.file;
    const vendorsData = JSON.parse(readFileSync(join(DATA, file), "utf-8"));
    const period = normalizePeriod(entry, t);
    const stats = buildRankingStats(rules, vendorsData.vendors);

    for (const vendor of vendorsData.vendors) {
      const p = profilesByCode[vendor.vendor_code] ?? null;
      const views = {
        overview: () => renderOverview({ rules, vendor, profile: p, period, stats }),
        performance: () => renderPerformance({ rules, vendor }),
        advice: () => renderAdvice({ rules, vendor, profile: p, period }),
        earnings: () => renderEarnings({ rules, vendor, period }),
        rules: () => renderRules({ rules, viewer: { city: vendor.city, seeAllCities: false } }),
        benchmark: () => renderBenchmark({
          rules, vendorsData, vendor, profilesByCode, rmName: rmOf(vendor.vendor_code),
        }),
      };
      for (const [name, fn] of Object.entries(views)) {
        const where = `${lang}/${entry.id}/${vendor.vendor_code}/${name}`;
        try {
          const html = fn();
          rendered++;
          problems.push(...scan(html, where, lang));
        } catch (e) {
          problems.push(`${where} → 抛异常：${e.message}`);
        }
      }
    }

    // RM 全盘 + 全城视图
    const rms = [...new Set((rmAssign.assignments ?? []).map((a) => a.rm).filter(Boolean))];
    for (const rm of [...rms, null]) {
      const roster = vendorsData.vendors.filter((v) => rm === null || rmOf(v.vendor_code) === rm);
      if (!roster.length) continue;
      const where = `${lang}/${entry.id}/${rm ?? "全部城市"}/portfolio`;
      try {
        const html = renderPortfolio({
          rules, roster, profilesByCode, period,
          scopeLabel: rm ?? t("portfolio.scope_all"), isAll: rm === null,
        });
        rendered++;
        problems.push(...scan(html, where, lang));
      } catch (e) {
        problems.push(`${where} → 抛异常：${e.message}`);
      }
    }
    // 规则页 RM 视角（可见全部城市）
    try {
      const html = renderRules({ rules, viewer: { city: null, seeAllCities: true } });
      rendered++;
      problems.push(...scan(html, `${lang}/${entry.id}/RM/rules_all_cities`, lang));
    } catch (e) {
      problems.push(`${lang}/${entry.id}/RM/rules_all_cities → 抛异常：${e.message}`);
    }
  }
}

console.log(`\n渲染 ${rendered} 个视图（${langs.join(" / ")}）`);
if (!problems.length) {
  console.log("✅ 无坏值：没有 NaN / undefined / 未替换占位符 / raw i18n 键，也没有渲染异常");
  process.exit(0);
}
// 同类问题会在上百家商上重复，按「问题类型 + 视图」归并，只留代表样本
const grouped = new Map();
for (const p of problems) {
  const m = p.match(/^[^/]+\/[^/]+\/(?:.+?)\/([a-z_]+) → (.+?)(?:：|$)/);
  const key = m ? `${m[1]} → ${m[2]}` : p;
  if (!grouped.has(key)) grouped.set(key, { count: 0, sample: p });
  grouped.get(key).count++;
}
console.log(`❌ ${problems.length} 处问题（归并为 ${grouped.size} 类）：\n`);
for (const [key, { count, sample }] of grouped) {
  console.log(`  [${count} 处] ${key}`);
  console.log(`     样本：${sample}`);
}
process.exit(1);
