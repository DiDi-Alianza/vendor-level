// 周度 vs 月度差异归因：逐项定量分解，回答「S+A 差距到底来自哪」
// 方法：对同一批商（归一化 key 交集），把周度的某一项得分换成月度值，其余不变，看 S+A 怎么变。
// 用法： bun scripts/diff_weekly_monthly.js 2026_w32 2026_07

import { validateRules, activeIndicators, determineLevel } from "../src/engine/rules.js";

const [wk, mo] = [process.argv[2], process.argv[3]];
const normCode = (s) => String(s).trim().normalize("NFD").replace(/\p{Mn}/gu, "").toUpperCase();
const rules = validateRules(await Bun.file("data/rules.json").json());

const W = (await Bun.file(`data/vendors_${wk}.json`).json()).vendors;
const Mraw = await Bun.file(`data/vendors_${mo}.json`).json();
const M = Array.isArray(Mraw) ? Mraw : Mraw.vendors;
const mMap = new Map(M.map((m) => [normCode(m.vendor_code), m]));

const IND = activeIndicators(rules).map((i) => i.key);
// 月度 json 的 indicators 用旧 key（r2/identity），做一次语义对齐
const ALIAS = { d3r: ["d3r", "r2"], blocked_rider_rate: ["blocked_rider_rate", "identity"] };
const mScore = (m, key) => {
  const cands = ALIAS[key] ?? [key];
  const it = m.indicators.find((x) => cands.includes(x.key));
  return it ? it.score : null;
};
const mValue = (m, key) => {
  const cands = ALIAS[key] ?? [key];
  const it = m.indicators.find((x) => cands.includes(x.key));
  return it ? it.value : null;
};

const pairs = [];
for (const w of W) {
  const m = mMap.get(w.vendor_key ?? normCode(w.vendor_code));
  if (m) pairs.push({ w, m });
}
const wOnly = W.length - pairs.length;
const mOnly = M.length - pairs.length;

const levelOf = (scores, city, ordersValue) => {
  let total = 0;
  for (const ind of activeIndicators(rules)) total += scores[ind.key] * ind.weight;
  const { level } = determineLevel(rules, city, total, { [rules.s_scale_gate.indicator]: ordersValue }, { redline: false });
  return { level, total };
};
const saCount = (levels) => levels.filter((l) => l === "S" || l === "A").length;

// 基线：交集内的周度 / 月度 S+A
const wLevels = pairs.map((p) => p.w.level);
const mLevels = pairs.map((p) => p.m.level);
const n = pairs.length;
console.log(`样本：周度 ${W.length} 家 | 月度 ${M.length} 家 | 交集 ${n} 家（仅周度有 ${wOnly}，仅月度有 ${mOnly}）`);
console.log(`\n【第一层：样本口径差异】`);
console.log(`  全量口径   周度 S+A ${saCount(wLevels)}/${W.length} = ${(saCount(W.map(x=>x.level))/W.length*100).toFixed(0)}%  |  月度 S+A ${saCount(M.map(x=>x.level))}/${M.length} = ${(saCount(M.map(x=>x.level))/M.length*100).toFixed(0)}%`);
console.log(`  同口径交集 周度 S+A ${saCount(wLevels)}/${n} = ${(saCount(wLevels)/n*100).toFixed(0)}%  |  月度 S+A ${saCount(mLevels)}/${n} = ${(saCount(mLevels)/n*100).toFixed(0)}%`);
console.log(`  → 仅月度有的 ${mOnly} 家（本周无账单）等级分布：` +
  JSON.stringify(M.filter((m) => !W.some((w) => (w.vendor_key ?? normCode(w.vendor_code)) === normCode(m.vendor_code)))
    .reduce((a, m) => (a[m.level] = (a[m.level] ?? 0) + 1, a), {})));

// 第二层：逐项替换归因
console.log(`\n【第二层：逐项把周度得分换成月度得分，看 S+A 变化（交集 ${n} 家）】`);
const baseW = saCount(wLevels);
const rows = [];
for (const key of IND) {
  const levels = pairs.map(({ w, m }) => {
    const scores = {};
    for (const k of IND) {
      const it = w.indicators.find((x) => x.key === k);
      scores[k] = k === key ? (mScore(m, k) ?? it.score) : it.score;
    }
    const ordersValue = key === rules.s_scale_gate.indicator
      ? (mValue(m, key) ?? w.indicators.find((x) => x.key === key).value)
      : w.indicators.find((x) => x.key === rules.s_scale_gate.indicator).value;
    return levelOf(scores, w.city, ordersValue).level;
  });
  rows.push({ key, sa: saCount(levels), delta: saCount(levels) - baseW });
}
rows.sort((a, b) => a.delta - b.delta);
console.log(`  周度基线 S+A = ${baseW} 家（${(baseW/n*100).toFixed(0)}%）`);
for (const r of rows) {
  const w = rules.indicators.find((i) => i.key === r.key).weight;
  console.log(`  换 ${r.key.padEnd(20)} (权重${(w*100).toFixed(0).padStart(3)}%) → S+A ${String(r.sa).padStart(3)} 家  变化 ${r.delta >= 0 ? "+" : ""}${r.delta}`);
}
// 全换 = 应等于月度
const allM = pairs.map(({ w, m }) => {
  const scores = {};
  for (const k of IND) scores[k] = mScore(m, k) ?? w.indicators.find((x) => x.key === k).score;
  return levelOf(scores, w.city, mValue(m, rules.s_scale_gate.indicator)).level;
});
console.log(`  全部换成月度 → S+A ${saCount(allM)} 家（校验：应接近月度交集 ${saCount(mLevels)} 家）`);

// 第三层：各指标得分均值对比
console.log(`\n【第三层：各指标平均得分（交集 ${n} 家）】`);
console.log(`  指标                  周度均分  月度均分   差`);
for (const key of IND) {
  const aw = pairs.reduce((s, { w }) => s + w.indicators.find((x) => x.key === key).score, 0) / n;
  const am = pairs.reduce((s, { m }) => s + (mScore(m, key) ?? 0), 0) / n;
  console.log(`  ${key.padEnd(20)} ${aw.toFixed(1).padStart(7)} ${am.toFixed(1).padStart(9)} ${(aw - am >= 0 ? "+" : "") + (aw - am).toFixed(1)}`);
}
