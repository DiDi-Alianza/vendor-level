// 六周对照评分 —— 用 src/engine/rules.js 算分，不另写实现。
// 规则 = rules.json + CR-20260814 最终态（在内存里补上尚未落盘的两条分数线）。
// 用法：bun scripts/score_weeks.js
import { validateRules, computeScores, determineLevel } from "../src/engine/rules.js";

const base = await Bun.file("data/rules.json").json();
const LINES = { CDMX: { S: 80, A: 55, C: 15 }, MTY: { S: 90, A: 65, C: 15 } };
const rules = validateRules(Object.assign(structuredClone(base), {
  level_lines: { ...base.level_lines, shared: {}, by_city: LINES },
}));

const WEEKS = ["2026-W27", "2026-W28", "2026-W29", "2026-W30", "2026-W31", "2026-W32"];
const KEYS = ["orders", "slot", "credit", "d3r", "newrider", "blocked_rider_rate"];
const LB = { orders: "完美单", slot: "Slot", credit: "信用", d3r: "D-3R", newrider: "拉新", blocked_rider_rate: "合规" };

const out = [];
for (const wk of WEEKS) {
  const src = await Bun.file(`data/_weekly_values_${wk}.json`).json();
  const rows = [];
  for (const v of src.vendors) {
    const values = { ...v.values };
    if (values.newrider == null) values.newrider = -1;      // 当期无招人 → 落 0 档
    if (values.slot == null || values.d3r == null || values.blocked_rider_rate == null) continue;
    const { scores, total } = computeScores(rules, values);
    // 周度：红线只有「单周命中」，不构成触发 → 不封顶
    const { level } = determineLevel(rules, v.city, total, {}, { redline: false });
    rows.push({ code: v.vendor_code, city: v.city, level, total, scores, values: v.values, raw: v.raw });
  }
  out.push({ wk, label: src.meta.period_label, rows });
}

const dist = (rows, city) => {
  const d = { S: 0, A: 0, B: 0, C: 0 };
  for (const r of rows) if (!city || r.city === city) d[r.level]++;
  const n = d.S + d.A + d.B + d.C;
  return { ...d, n, sa: n ? ((d.S + d.A) / n) * 100 : 0 };
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

console.log("═══ 六周分布（同一套规则、同一分数线）═══");
console.log("周次        区间                    家数    S    A    B    C   S+A%   均分  中位");
for (const { wk, label, rows } of out) {
  const d = dist(rows);
  const t = rows.map((r) => r.total);
  const rng = label.match(/（(.+)）/)?.[1] ?? "";
  console.log(`${wk}  ${rng}  ${String(d.n).padStart(4)} ${String(d.S).padStart(4)} ${String(d.A).padStart(4)} ` +
    `${String(d.B).padStart(4)} ${String(d.C).padStart(4)} ${d.sa.toFixed(1).padStart(6)}  ${mean(t).toFixed(1).padStart(5)} ${med(t).toFixed(1).padStart(5)}`);
}

console.log("\n═══ 分城 S+A% ═══");
console.log("周次           CDMX      MTY");
for (const { wk, rows } of out) {
  console.log(`${wk}   ${dist(rows, "CDMX").sa.toFixed(1).padStart(6)}%  ${dist(rows, "MTY").sa.toFixed(1).padStart(6)}%`);
}

console.log("\n═══ 各指标周均分走势 ═══");
console.log("指标      " + out.map((o) => o.wk.slice(5).padStart(7)).join(""));
for (const k of KEYS) {
  console.log(LB[k].padEnd(9) + out.map((o) => mean(o.rows.map((r) => r.scores[k])).toFixed(1).padStart(7)).join(""));
}

console.log("\n═══ 关键原始值中位数 ═══");
const rawMed = (rows, f) => med(rows.map(f).filter((x) => x != null));
console.log("指标           " + out.map((o) => o.wk.slice(5).padStart(8)).join(""));
console.log("Slot达成%     " + out.map((o) => rawMed(o.rows, (r) => r.values.slot).toFixed(1).padStart(8)).join(""));
console.log("日均完美单     " + out.map((o) => rawMed(o.rows, (r) => r.values.orders).toFixed(0).padStart(8)).join(""));
console.log("D-3R%         " + out.map((o) => rawMed(o.rows, (r) => r.values.d3r).toFixed(2).padStart(8)).join(""));
console.log("信用满分家数   " + out.map((o) => {
  const n = o.rows.filter((r) => r.values.credit && (r.values.credit.no_debt || r.values.credit.overdue_ratio === 0)).length;
  return `${n}/${o.rows.length}`.padStart(8);
}).join(""));
console.log("零封禁家数     " + out.map((o) => {
  const n = o.rows.filter((r) => r.values.blocked_rider_rate === 0).length;
  return `${n}/${o.rows.length}`.padStart(8);
}).join(""));

// 校验锚点：W32 应与既有报告一致
const w32 = dist(out.find((o) => o.wk === "2026-W32").rows);
console.log(`\n校验 W32: S${w32.S} A${w32.A} B${w32.B} C${w32.C} n=${w32.n} SA=${w32.sa.toFixed(1)}%  ` +
  `（既有报告 S14 A38 B40 C1 n=93 SA=55.9% → ${w32.S === 14 && w32.A === 38 && w32.B === 40 && w32.C === 1 ? "✅ 一致" : "❌ 不一致，需排查"}）`);

await Bun.write("data/_weeks_compare.json", JSON.stringify(
  out.map(({ wk, label, rows }) => ({ wk, label, dist: dist(rows), cdmx: dist(rows, "CDMX"), mty: dist(rows, "MTY") })), null, 1));
