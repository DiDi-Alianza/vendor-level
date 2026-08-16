// CR-20260814 最终试算：分数线方案对比 + 成本 + 与 7 月官方等级对比
// 算分走 src/engine（唯一实现）；规则变更在内存中应用，不写 rules.json
import { validateRules, computeScores, determineLevel, estimateIncentive } from "../src/engine/rules.js";

const src = await Bun.file("data/_monthly_values_2026-07.json").json();
const base = await Bun.file("data/rules.json").json();
const NR = [70, 50, 30];   // 拉新档位（0814 定：四个月落档最均衡，中位 50% 正好当 80 分线）

function makeRules(lines) {
  const r = structuredClone(base);
  r.s_scale_gate.enabled = false;
  const c = r.indicators.find((i) => i.composite);
  c.composite.components = c.composite.components.filter((x) => x.key === "overdue_ratio");
  c.composite.components[0].weight = 1.0;
  const nr = r.indicators.find((i) => i.key === "newrider");
  nr.tiers = [{ gte: NR[0], score: 100 }, { gte: NR[1], score: 80 }, { gte: NR[2], score: 50 }, { gte: 0, score: 0 }];
  r.level_lines.shared = {};
  r.level_lines.by_city = lines;
  return validateRules(r);
}
const rulesProbe = makeRules({ CDMX: { S: 80, A: 45, C: 15 }, MTY: { S: 85, A: 65, C: 15 } });
const rows = src.vendors.map((v) => {
  const values = { ...v.values };
  if (values.newrider == null) values.newrider = -1;      // 当月未招新人 → 0 分档
  const { scores, total } = computeScores(rulesProbe, values);
  return { code: v.vendor_code, city: v.city, total, scores, perfect: v.raw.perfect_orders,
           v1: v.official_level_v1, newriderNull: v.values.newrider == null };
});

const PLANS = {
  "最终方案": { CDMX: { S: 80, A: 45, C: 15 }, MTY: { S: 85, A: 65, C: 15 } },
  "敏感性 A线±5": { CDMX: { S: 80, A: 50, C: 15 }, MTY: { S: 85, A: 70, C: 15 } },
  "敏感性 A线-5": { CDMX: { S: 80, A: 40, C: 15 }, MTY: { S: 85, A: 60, C: 15 } },
  "敏感性 C线20": { CDMX: { S: 80, A: 45, C: 20 }, MTY: { S: 85, A: 65, C: 20 } },
};
const CAP = base.incentive.per_vendor_monthly_cap, RATE = base.incentive.rates;

console.log(`样本 ${rows.length} 家 | 拉新档位 ≥${NR[0]}/${NR[1]}/${NR[2]}%\n`);
console.log("方案".padEnd(18) + "城市    S   A    B    C   S+A%   月成本(MXN)");
const results = {};
for (const [name, lines] of Object.entries(PLANS)) {
  const rules = makeRules(lines);
  const lv = rows.map((r) => ({ ...r, level: determineLevel(rules, r.city, r.total, {}, { redline: false }).level }));
  let cost = 0;
  for (const r of lv) cost += Math.min(r.perfect * (RATE[r.level] ?? 0), CAP);
  const out = [];
  for (const city of ["CDMX", "MTY"]) {
    const cs = lv.filter((r) => r.city === city);
    const d = { S: 0, A: 0, B: 0, C: 0 };
    for (const r of cs) d[r.level]++;
    out.push({ city, ...d, n: cs.length, sa: (d.S + d.A) / cs.length * 100 });
  }
  const tot = { S: 0, A: 0, B: 0, C: 0 };
  for (const r of lv) tot[r.level]++;
  results[name] = { lines, out, tot, cost, lv };
  out.forEach((o, i) => {
    console.log((i === 0 ? name.padEnd(18) : "".padEnd(18)) +
      `${o.city.padEnd(6)}${String(o.S).padStart(3)}${String(o.A).padStart(4)}${String(o.B).padStart(5)}${String(o.C).padStart(5)}${o.sa.toFixed(0).padStart(6)}%` +
      (i === 0 ? `   ${(cost / 1e4).toFixed(1)} 万` : ""));
  });
  console.log("".padEnd(18) + `合计  ${String(tot.S).padStart(3)}${String(tot.A).padStart(4)}${String(tot.B).padStart(5)}${String(tot.C).padStart(5)}${((tot.S + tot.A) / rows.length * 100).toFixed(0).padStart(6)}%`);
}

// 推荐方案详情
const R = results["最终方案"];
console.log(`\n=== 方案 1 详情 ===`);
console.log("S 名单:", R.lv.filter((r) => r.level === "S").map((r) => `${r.code.slice(0, 20)}(${r.city} ${r.total.toFixed(1)})`).join(", "));
const ORDER = { S: 0, A: 1, B: 2, C: 3 };
let up = 0, down = 0, same = 0, noV1 = 0;
for (const r of R.lv) {
  if (!r.v1) { noV1++; continue; }
  const d = ORDER[r.level] - ORDER[r.v1];
  d < 0 ? up++ : d > 0 ? down++ : same++;
}
console.log(`vs 7月官方(V1)：不变 ${same} | 升 ${up} | 降 ${down} | 官方无评级 ${noV1}`);
const dz = R.lv.filter((r) => r.scores.orders === 0 && r.scores.slot === 0).length;
console.log(`双 0 分档：${dz} 家 | 当月未招新人(拉新计 0 分)：${rows.filter((r) => r.newriderNull).length} 家`);
console.log(`月成本 ${(R.cost / 1e4).toFixed(1)} 万 vs 现行实发 388 万 → ${((R.cost / 3878006 - 1) * 100).toFixed(0)}%`);
const capped = R.lv.filter((r) => r.perfect * (RATE[r.level] ?? 0) > CAP);
console.log(`触 50 万封顶：${capped.map((r) => r.code.slice(0, 16)).join(", ") || "无"}`);
