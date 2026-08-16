// Vendor-level rating simulation report (EN) for RM leadership
// Engine: src/engine/rules.js (single source of truth). CR-20260814 rules applied in memory.
// Usage: bun scripts/vendor_report_en.js
import { validateRules, computeScores, determineLevel } from "../src/engine/rules.js";

const base = await Bun.file("data/rules.json").json();
const rmMap = await Bun.file("data/rm_assignment.json").json().catch(() => ({}));
const NR = [70, 50, 30];
// 逾期>7天占比档位（越低越好）。占比 = 0 即「无逾期」→ 100，与完全无欠款同分；
// 有欠款但全在账期内的商不应因此被扣分。
// ★ 0 分档带等号：≥50% → 0（第三档用 lt，不是 lte）
const CREDIT = [{ lte: 0, score: 100 }, { lte: 20, score: 80 }, { lt: 50, score: 50 }, { lte: null, score: 0 }];
// ★ 0 分档一律带等号（≤边界值 → 0 分）。
// 引擎的 higher_better 只支持 gte，无 gt 算子 → 这里用极小量表达「严格大于」。
// 正式落 rules.json 时应改用 gt（见变更单 A11，需网站会话给引擎加 gt 支持）。
const EPS = 1e-9;
const HB = {                                   // 越高越好：第三档 = 严格大于边界
  orders:   [{ gte: 1250, score: 100 }, { gte: 500, score: 80 }, { gte: 100 + EPS, score: 50 }, { gte: 0, score: 0 }],
  slot:     [{ gte: 90,   score: 100 }, { gte: 70,  score: 80 }, { gte: 40  + EPS, score: 50 }, { gte: 0, score: 0 }],
  newrider: [{ gte: NR[0], score: 100 }, { gte: NR[1], score: 80 }, { gte: NR[2] + EPS, score: 50 }, { gte: 0, score: 0 }],
};
// 越低越好：第三档 lte→lt，使 ≥边界 落 0 分。d3r 本就是 lt 3 / else→0，已带等号，不动。
const BLOCKED = [{ lte: 0, score: 100 }, { lte: 5, score: 80 }, { lt: 15, score: 50 }, { lte: null, score: 0 }];
// CR-20260814 A3–A7 重标定（2026-08-14，BUG-003 修数后）：方案甲
const LINES = { CDMX: { S: 80, A: 55, C: 15 }, MTY: { S: 90, A: 65, C: 15 } };
const normCode = (s) => String(s).trim().normalize("NFD").replace(/\p{Mn}/gu, "").toUpperCase();

function makeRules() {
  const r = structuredClone(base);
  r.s_scale_gate.enabled = false;
  const c = r.indicators.find((i) => i.composite);
  // CR-20260814 B1：坏账(>30天)不再参与计分，信用分只看逾期>7天占比
  c.composite.components = c.composite.components.filter((x) => x.key === "overdue_ratio");
  c.composite.components[0].weight = 1.0;
  // CR-20260814 A10：满分只给「无逾期」，原 ≤10%→100 档并入 80 分档
  c.composite.components[0].tiers = CREDIT;
  c.composite.no_debt_score = 100;
  for (const [k, tiers] of Object.entries(HB)) {
    const ind = r.indicators.find((i) => i.key === k);
    if (ind) ind.tiers = tiers;
  }
  const blk = r.indicators.find((i) => i.key === "blocked_rider_rate");
  if (blk) blk.tiers = BLOCKED;
  r.level_lines.shared = {};
  r.level_lines.by_city = LINES;
  return validateRules(r);
}
const rules = makeRules();

// RM lookup（结构未知时安全降级）
const rmOf = (code) => {
  const k = normCode(code);
  if (Array.isArray(rmMap)) {
    const hit = rmMap.find((x) => normCode(x.vendor_code ?? x.code ?? "") === k);
    return hit?.rm ?? hit?.RM ?? hit?.rm_name ?? null;
  }
  if (rmMap && typeof rmMap === "object") {
    for (const [kk, vv] of Object.entries(rmMap)) {
      if (normCode(kk) === k) return typeof vv === "string" ? vv : (vv?.rm ?? vv?.RM ?? null);
    }
    for (const list of [rmMap.assignments, rmMap.vendors]) {
      if (!Array.isArray(list)) continue;
      const hit = list.find((x) => normCode(x.vendor_code ?? "") === k);
      if (hit) return hit.rm ?? hit.RM ?? hit.rm_name ?? null;
    }
  }
  return null;
};

function score(file, isWeekly) {
  const rows = [];
  for (const v of file.vendors) {
    const values = { ...v.values };
    if (values.newrider == null) values.newrider = -1;   // no new hires that period → 0 band
    if (values.slot == null || values.d3r == null || values.blocked_rider_rate == null) continue;
    const { scores, total } = computeScores(rules, values);
    const { level } = determineLevel(rules, v.city, total, {}, { redline: false });
    rows.push({
      code: v.vendor_code, key: normCode(v.vendor_code), city: v.city,
      level, total: Math.round(total * 10) / 10, scores, values: v.values, raw: v.raw,
      v1: v.official_level_v1 ?? null,
      redlineWeek: isWeekly ? !!v.redline_week_hit : null,
    });
  }
  return rows;
}

const jul = score(await Bun.file("data/_monthly_values_2026-07.json").json(), false);
const wk = score(await Bun.file("data/_weekly_values_2026-W32.json").json(), true);
const wkMap = new Map(wk.map((r) => [r.key, r]));

const ORDER = { S: 0, A: 1, B: 2, C: 3 };
const dist = (rows, city) => {
  const d = { S: 0, A: 0, B: 0, C: 0 };
  for (const r of rows) if (!city || r.city === city) d[r.level]++;
  const n = Object.values(d).reduce((a, b) => a + b, 0);
  return { ...d, n, sa: n ? ((d.S + d.A) / n * 100) : 0 };
};
const CAP = base.incentive.per_vendor_monthly_cap, RATE = base.incentive.rates;
const monthOrders = (r) => r.raw.perfect_orders ?? 0;
const cost = jul.reduce((s, r) => s + Math.min(monthOrders(r) * (RATE[r.level] ?? 0), CAP), 0);

// weakest indicator (lowest weighted contribution among 0/50-score items)
const LABEL = { orders: "Daily perfect orders", slot: "Slot achievement", credit: "Repayment credit",
                d3r: "D-3R%", newrider: "New rider ratio", blocked_rider_rate: "Account compliance" };
function weakest(r) {
  const inds = rules.indicators.filter((i) => i.enabled !== false);
  let worst = null;
  for (const i of inds) {
    const s = r.scores[i.key];
    const loss = (100 - s) * i.weight;
    if (!worst || loss > worst.loss) worst = { key: i.key, score: s, loss };
  }
  return worst && worst.loss > 0 ? `${LABEL[worst.key]} (${worst.score} pts)` : "—";
}

const out = {
  meta: {
    title: "Vendor Level Simulation under the New Rules (CR-20260814)",
    generated: "2026-08-14",
    engine: "src/engine/rules.js — same implementation used by the site and recalc",
    thresholds: LINES,
    newrider_bands: `≥${NR[0]}% / ${NR[1]}–${NR[0]}% / ${NR[2]}–${NR[1]}% / <${NR[2]}%`,
    disclaimer: "Simulation on actual data. Not an official rating. Weekly figures are a trend check only — do not compare directly with monthly results.",
  },
  july: { by_city: { CDMX: dist(jul, "CDMX"), MTY: dist(jul, "MTY") }, total: dist(jul), monthly_incentive_mxn: Math.round(cost) },
  week: { by_city: { CDMX: dist(wk, "CDMX"), MTY: dist(wk, "MTY") }, total: dist(wk) },
  vendors: jul.sort((a, b) => (a.city.localeCompare(b.city)) || ORDER[a.level] - ORDER[b.level] || b.total - a.total)
    .map((r) => {
      const w = wkMap.get(r.key);
      return {
        vendor_code: r.code, city: r.city, rm: rmOf(r.code),
        level_july_new_rules: r.level,
        level_july_current_rules: r.v1,
        change_vs_current: r.v1 ? (ORDER[r.level] < ORDER[r.v1] ? "UP" : ORDER[r.level] > ORDER[r.v1] ? "DOWN" : "SAME") : "N/A",
        score_july: r.total,
        level_week_2026W32: w ? w.level : null,
        score_week: w ? w.total : null,
        weakest_metric: weakest(r),
        scores: r.scores,
        metrics: {
          daily_perfect_orders: r.values.orders,
          slot_pct: r.values.slot,
          overdue_ratio_pct: r.values.credit?.overdue_ratio ?? null,
          no_debt: r.values.credit?.no_debt ?? null,
          d3r_pct: r.values.d3r,
          new_rider_pct: r.values.newrider,
          blocked_rider_pct: r.values.blocked_rider_rate,
        },
        raw: r.raw,
        redline_hit_week: w ? w.redlineWeek : null,
      };
    }),
};
await Bun.write("data/_report_en_2026-07.json", JSON.stringify(out, null, 1));
console.log("July  :", JSON.stringify(out.july));
console.log("Week32:", JSON.stringify(out.week));
console.log(`vendors: ${out.vendors.length} | RM matched: ${out.vendors.filter((v) => v.rm).length}`);
console.log("→ data/_report_en_2026-07.json");
