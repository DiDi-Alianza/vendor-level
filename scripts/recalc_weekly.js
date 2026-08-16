// 周度算分：取数层产物 → src/engine（唯一算分实现）→ data/vendors_<period>.json
// schema 与 data/vendors_2026_07.json 对齐；本脚本不含任何权重/阈值/分数线字面值。
//
// 用法： bun scripts/recalc_weekly.js 2026-W32
//        bun scripts/recalc_weekly.js 2026-W32 --compare 2026_07

import {
  validateRules, activeIndicators, computeScores, scoreComposite, isCompositeInput,
  determineLevel, estimateIncentive,
} from "../src/engine/rules.js";

const period = process.argv[2];
if (!period) {
  console.error("用法: bun scripts/recalc_weekly.js <period>   例: 2026-W32");
  process.exit(1);
}
const cmpIdx = process.argv.indexOf("--compare");
const comparePeriod = cmpIdx > -1 ? process.argv[cmpIdx + 1] : null;

/** vendor_code 归一化：去重音 + 转大写。主键用完整全串，禁用数字后缀。
 *  已知源表不一致：ENVÍAGUIA/ENVIAGUIA、ALEJANDRO/Alejandro */
const normCode = (s) => String(s).trim().normalize("NFD").replace(/\p{Mn}/gu, "").toUpperCase();

const rules = validateRules(await Bun.file("data/rules.json").json());
const src = await Bun.file(`data/_weekly_values_${period}.json`).json();
const creditRule = activeIndicators(rules).find(isCompositeInput);
const DOUBLE_ZERO_BRANCH = rules.advice_branches.find((b) => b.key === "double_zero");

const out = [];
const engineIssues = [];

for (const v of src.vendors) {
  const values = { ...v.values };
  let creditParts = null;

  // 复合指标：原始分项对象直接交给引擎（scoreIndicator 内部走 scoreComposite）
  if (creditRule) {
    const cc = v.values[creditRule.key];
    if (!cc) { engineIssues.push({ vendor_code: v.vendor_code, issue: "credit_components_missing" }); continue; }
    const r = scoreComposite(creditRule, cc, { noDebt: cc.no_debt === true });
    creditParts = typeof r === "number" ? null : r.parts;   // 仅用于明细展示，分数仍由引擎统一算
  }

  const missing = activeIndicators(rules)
    .filter((ind) => values[ind.key] === null || values[ind.key] === undefined)
    .map((ind) => ind.key);
  if (missing.length) { engineIssues.push({ vendor_code: v.vendor_code, issue: "value_missing", indicators: missing }); continue; }

  const { scores, total } = computeScores(rules, values);
  // 周度：红线只有「单周命中」，不构成触发 → 不封顶
  const { level, sScaleGateBlocked, levelBeforeCap } =
    determineLevel(rules, v.city, total, values, { redline: false });
  const incentive = estimateIncentive(rules, level, v.raw.perfect_orders, { redline: false });

  const dzCond = DOUBLE_ZERO_BRANCH?.condition?.all ?? [];
  const doubleZero = dzCond.length > 0 && dzCond.every((c) => scores[c.indicator] === c.score_eq);

  // indicators 数组：schema 与月度一致
  const indicators = activeIndicators(rules).map((ind) => {
    const item = {
      key: ind.key,
      name_key: ind.name_key,
      weight: ind.weight,
      value: (ind.key === creditRule?.key ? (typeof values[ind.key] === "object" ? scores[ind.key] : values[ind.key]) : values[ind.key]),
      unit: ind.unit,
      score: scores[ind.key],
      tiers: ind.tiers ?? null,
    };
    if (ind.direction === "lower_better") item.lower_is_better = true;
    if (ind.key === creditRule?.key) {
      item.composite = creditRule.composite.components.map((c) => ({ key: c.key, weight: c.weight }));
      item.composite_parts = creditParts;
      item.composite_values = {
        overdue_ratio: v.values[creditRule.key].overdue_ratio,
        bad_debt_ratio: v.values[creditRule.key].bad_debt_ratio,
        no_debt: v.values[creditRule.key].no_debt,
      };
    }
    return item;
  });

  const lines = { ...rules.level_lines.shared, ...rules.level_lines.by_city[v.city] };
  out.push({
    vendor_code: v.vendor_code,
    vendor_key: normCode(v.vendor_code),
    city: v.city,
    level,
    level_before_cap: levelBeforeCap,
    total_score: Math.round(total * 10) / 10,
    lines,
    redline: false,                          // 周度不判定触发
    redline_week_hit: v.redline_week_hit,    // 单周命中（≠触发）
    redline_triggered: null,                 // 需整月数据，本期无法判定
    s_scale_gate_blocked: sScaleGateBlocked, // 规则实时计算，不取自任何备注文本
    double_zero: doubleZero,
    protection_status: null,                 // 周度不适用
    clearance_count: null,                   // 周度不计入累计
    indicators,
    raw: v.raw,
    incentive_estimate: incentive,
    issues: v.issues,
    note: null,
  });
}

// ---- 分布 ----
const byCity = {};
for (const o of out) { const c = (byCity[o.city] ??= { S: 0, A: 0, B: 0, C: 0, n: 0 }); c[o.level]++; c.n++; }
const totalDist = { S: 0, A: 0, B: 0, C: 0 };
for (const o of out) totalDist[o.level]++;

const result = {
  meta: {
    period: `${period}（${src.meta.period_label}）`,
    period_type: "weekly",
    days_in_period: src.meta.days_in_period,
    source: `取数 scripts/extract_weekly.py ← ${Object.values(src.meta.sources).join(" / ")}`,
    engine: "src/engine/rules.js（与网站页面、scripts/recalc.js 同一实现）",
    model_version: `${rules.version} / status=${rules.status} / effective_from=${rules.effective_from}`,
    vendor_count: out.length,
    level_lines: rules.level_lines,
    s_scale_gate: rules.s_scale_gate,
    incentive: rules.incentive,
    distribution: { by_city: byCity, total: totalDist },
    disclaimer: src.meta.disclaimer,
    caveats: [
      src.meta.redline_note,
      src.meta.flex_adjustment,
      "保护期与清退累计一律不适用于周度（protection_status / clearance_count 均为 null）",
      "档位阈值按月度口径校准：周口径下「新骑手占比」系统性偏严、「合规账号率」系统性偏松，二者方向相反可部分抵消，但周度结果不宜与月度直接对比",
    ],
    data_issues: src.meta.data_issues,
    engine_issues: engineIssues,
  },
  vendors: out,
};

const outPath = `data/vendors_${period.replace("-", "_").toLowerCase()}.json`;

console.log(`周度算分完成（引擎 src/engine/rules.js）→ ${outPath}`);
console.log(`  规则 ${rules.version} / status=${rules.status}`);
for (const [city, c] of Object.entries(byCity)) {
  console.log(`  ${city}: S${c.S} A${c.A} B${c.B} C${c.C} | n=${c.n} | S+A ${((c.S + c.A) / c.n * 100).toFixed(0)}%`);
}
console.log(`  合计: S${totalDist.S} A${totalDist.A} B${totalDist.B} C${totalDist.C} | n=${out.length}`);
console.log(`  单周红线命中 ${out.filter((o) => o.redline_week_hit).length} 家 | S门槛拦截 ${out.filter((o) => o.s_scale_gate_blocked).length} 家 | 双0 ${out.filter((o) => o.double_zero).length} 家`);
if (engineIssues.length) {
  console.log(`  ⚠️ 未能计算 ${engineIssues.length} 家：`);
  for (const e of engineIssues) console.log(`     ${e.vendor_code} — ${e.issue}${e.indicators ? " " + e.indicators.join(",") : ""}`);
}

// ---- 与月度对比（归一化 key 匹配） ----
if (comparePeriod) {
  const prevRaw = await Bun.file(`data/vendors_${comparePeriod}.json`).json();
  const prevList = Array.isArray(prevRaw) ? prevRaw : prevRaw.vendors;
  const prevMap = new Map(prevList.map((p) => [normCode(p.vendor_code), p]));
  const ORDER = { S: 0, A: 1, B: 2, C: 3 };
  const up = [], down = [], same = [], onlyNow = [], onlyPrev = [];
  for (const o of out) {
    const p = prevMap.get(o.vendor_key);
    if (!p) { onlyNow.push(o.vendor_code); continue; }
    const d = ORDER[o.level] - ORDER[p.level];
    const item = { vendor_code: o.vendor_code, from: p.level, to: o.level, score_from: p.total_score, score_to: o.total_score };
    (d < 0 ? up : d > 0 ? down : same).push(item);
  }
  const nowKeys = new Set(out.map((o) => o.vendor_key));
  for (const p of prevList) if (!nowKeys.has(normCode(p.vendor_code))) onlyPrev.push(p.vendor_code);

  const dzPrev = prevList.filter((p) => p.double_zero === true).length;
  const dzNow = out.filter((o) => o.double_zero).length;
  const rlPrevSet = new Set(prevList.filter((p) => p.redline === true).map((p) => normCode(p.vendor_code)));
  const rlNowSet = new Set(out.filter((o) => o.redline_week_hit).map((o) => o.vendor_key));
  const rlNew = [...rlNowSet].filter((k) => !rlPrevSet.has(k));
  const rlGone = [...rlPrevSet].filter((k) => !rlNowSet.has(k));
  const codeOf = (k) => (out.find((o) => o.vendor_key === k) ?? prevList.find((p) => normCode(p.vendor_code) === k))?.vendor_code ?? k;

  console.log(`\n=== 与 ${comparePeriod} 月度对比（周度试算，仅供趋势参考）===`);
  console.log(`  等级不变 ${same.length} | 上升 ${up.length} | 下降 ${down.length}`);
  console.log(`  双 0 分档：本期 ${dzNow} 家 ← 月度 ${dzPrev} 家`);
  console.log(`  红线：本周新增命中 ${rlNew.length} 家（${rlNew.map(codeOf).join(", ") || "无"}）；月度触发而本周未命中 ${rlGone.length} 家`);
  console.log(`  仅本期有 ${onlyNow.length} 家（${onlyNow.join(", ") || "无"}）`);
  console.log(`  仅月度有 ${onlyPrev.length} 家（本周无账单，多为停业/退出）：${onlyPrev.join(", ") || "无"}`);
  if (up.length) console.log(`  ↑ ${up.map((x) => `${x.vendor_code} ${x.from}→${x.to}`).slice(0, 10).join(" | ")}${up.length > 10 ? ` …共${up.length}` : ""}`);
  if (down.length) console.log(`  ↓ ${down.map((x) => `${x.vendor_code} ${x.from}→${x.to}`).slice(0, 10).join(" | ")}${down.length > 10 ? ` …共${down.length}` : ""}`);

  result.meta.comparison = {
    against: comparePeriod, note: "周度试算 vs 月度正式评级，口径不同，仅供趋势参考",
    unchanged: same.length, up: up.length, down: down.length,
    up_list: up, down_list: down,
    double_zero: { now: dzNow, compare: dzPrev },
    redline: { newly_hit: rlNew.map(codeOf), no_longer_hit: rlGone.map(codeOf) },
    only_this_period: onlyNow, only_compare_period: onlyPrev,
  };
}

await Bun.write(outPath, JSON.stringify(result, null, 1));
