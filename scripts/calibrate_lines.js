// 分数线试算（CR-20260814）——在内存中应用变更，**不写 rules.json**
// 算分一律走 src/engine（唯一实现）。用法：
//   bun scripts/calibrate_lines.js 2026-07
import { validateRules, activeIndicators, computeScores, determineLevel, estimateIncentive }
  from "../src/engine/rules.js";

const period = process.argv[2] ?? "2026-07";
const src = await Bun.file(`data/_monthly_values_${period}.json`).json();
const base = await Bun.file("data/rules.json").json();

// ---- 在内存中应用 CR-20260814 的规则变更（不落盘）----
function makeRules({ newriderBands, lines, noNewRiderScore = 0 }) {
  const r = structuredClone(base);
  r.s_scale_gate.enabled = false;                       // A1 删除 S 规模门槛
  const credit = r.indicators.find((i) => i.composite);  // B1 信用改单分项
  credit.composite.components = credit.composite.components.filter((c) => c.key === "overdue_ratio");
  credit.composite.components[0].weight = 1.0;
  const nr = r.indicators.find((i) => i.key === "newrider");   // B3 拉新档位重设
  nr.tiers = [
    { gte: newriderBands[0], score: 100 }, { gte: newriderBands[1], score: 80 },
    { gte: newriderBands[2], score: 50 }, { gte: 0, score: 0 },
  ];
  r.level_lines.shared = {};                            // A2 S 线不再全市场统一
  r.level_lines.by_city = lines;
  r._noNewRiderScore = noNewRiderScore;
  return validateRules(r);
}

function scoreAll(rules) {
  const out = [];
  for (const v of src.vendors) {
    const values = { ...v.values };
    if (values.newrider === null || values.newrider === undefined) values.newrider = -1; // 未招新人 → 落 0 档
    if (values.slot === null || values.d3r === null || values.blocked_rider_rate === null) continue;
    const { scores, total } = computeScores(rules, values);
    out.push({ code: v.vendor_code, city: v.city, total, scores,
               perfect: v.raw.perfect_orders, v1: v.official_level_v1 });
  }
  return out;
}
const levelOf = (rules, city, total) =>
  determineLevel(rules, city, total, {}, { redline: false }).level;

// ---- 候选拉新档位 ----
const NR_CANDS = {
  "A 分位(80/50/35)": [80, 50, 35],
  "B 整十(80/60/40)": [80, 60, 40],
  "C 整五(75/55/35)": [75, 55, 35],
  "D 整十(90/70/50)": [90, 70, 50],
};

// ---- 第一步：定拉新档位对总分分布的影响 ----
console.log(`样本：${src.vendors.length} 家（${src.meta.period_label}）\n`);
console.log("=== 拉新档位候选对综合分的影响 ===");
const probeLines = { CDMX: { S: 80, A: 65, C: 30 }, MTY: { S: 80, A: 75, C: 35 } };
for (const [name, bands] of Object.entries(NR_CANDS)) {
  const rules = makeRules({ newriderBands: bands, lines: probeLines });
  const rows = scoreAll(rules);
  const avg = rows.reduce((s, r) => s + r.total, 0) / rows.length;
  const med = rows.map((r) => r.total).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  console.log(`  ${name.padEnd(20)} 综合分 均值 ${avg.toFixed(1)} 中位 ${med.toFixed(1)}`);
}

// ---- 第二步：网格搜索 A 线（整5），使两城 S+A ≈ 30% ----
const CHOSEN = process.env.NR_BANDS ? JSON.parse(process.env.NR_BANDS) : NR_CANDS["C 整五(75/55/35)"];
console.log(`\n=== 用拉新档位 [${CHOSEN.join("/")}] 搜索分数线 ===`);
const rules0 = makeRules({ newriderBands: CHOSEN, lines: probeLines });
const rows = scoreAll(rules0);
console.log(`可计算 ${rows.length} 家（缺值跳过 ${src.vendors.length - rows.length} 家）`);

for (const city of ["CDMX", "MTY"]) {
  const cs = rows.filter((r) => r.city === city).map((r) => r.total).sort((a, b) => b - a);
  const n = cs.length;
  const target = Math.round(n * 0.30);
  console.log(`\n${city}: n=${n}，目标 S+A ≈ ${target} 家（30%）`);
  console.log(`  综合分分布: max ${cs[0].toFixed(1)} | p10 ${cs[Math.floor(n*.1)].toFixed(1)} | p25 ${cs[Math.floor(n*.25)].toFixed(1)} | p30 ${cs[Math.floor(n*.3)].toFixed(1)} | 中位 ${cs[Math.floor(n*.5)].toFixed(1)}`);
  const rowsOut = [];
  for (let A = 40; A <= 90; A += 5) {
    const sa = cs.filter((x) => x >= A).length;
    rowsOut.push({ A, sa, pct: (sa / n * 100) });
  }
  const best = rowsOut.reduce((b, x) => Math.abs(x.pct - 30) < Math.abs(b.pct - 30) ? x : b);
  for (const x of rowsOut) {
    if (Math.abs(x.pct - 30) <= 12) {
      console.log(`   A≥${String(x.A).padStart(2)} → S+A ${String(x.sa).padStart(3)} 家 (${x.pct.toFixed(0)}%)${x.A === best.A ? "   ← 最接近 30%" : ""}`);
    }
  }
  // S 线：在 SA 内部切分
  console.log(`  S 线候选（A 线取 ${best.A}）：`);
  for (let S = best.A + 5; S <= 95; S += 5) {
    const sCnt = cs.filter((x) => x >= S).length;
    if (sCnt >= 1 && sCnt <= 10) console.log(`   S≥${S} → S ${sCnt} 家`);
  }
}
