// 规则变更影响面报告（CLAUDE.md「规则变更流程」第 4/5 步）
//   bun scripts/rule_change_impact.js                 # 对比基线，输出影响面
//   bun scripts/rule_change_impact.js --save-baseline # 核对通过后把当前结果留档为新基线
//   bun scripts/rule_change_impact.js --period 2026-W32
//
// 基线：data/baseline_<period>.json（首次运行自动以数据文件里的既有 level/total_score 为基线，
// 即 V6 原始测算结果）。规则变更后与基线失配是预期的——那正是要报的影响面。
//
// ⚠️ 只适用于「改阈值/权重/分数线」这类改动。若改的是口径/算法/分母，
// vendors_*.json 里的原始值已作废，本脚本的结果无意义——必须等新数据文件。

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { validateRules, computeScores, determineLevel, adviceBranch, applyFlexAdjustment, estimateIncentive } from "../src/engine/rules.js";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const saveBaseline = args.includes("--save-baseline");
const pIdx = args.indexOf("--period");           // 不存在时 indexOf 返回 -1，不能直接 +1 取值
const periodArg = pIdx >= 0 ? args[pIdx + 1] : undefined;

const rules = validateRules(JSON.parse(readFileSync(join(SITE, "data", "rules.json"), "utf-8")));
const index = JSON.parse(readFileSync(join(SITE, "data", "periods.json"), "utf-8"));
const entry = [...index.monthly, ...index.weekly].find((e) => e.id === (periodArg ?? index.default.id));
if (!entry) {
  console.error(`找不到评定期 ${periodArg}。可选：${[...index.monthly, ...index.weekly].map((e) => e.id).join(", ")}`);
  process.exit(1);
}
const data = JSON.parse(readFileSync(join(SITE, "data", entry.file), "utf-8"));
const baselinePath = join(SITE, "data", `baseline_${entry.id}.json`);

const fmtMoney = (n) => `MX$${Math.round(n).toLocaleString("en-US")}`;
const pct = (a, b) => (b === 0 ? "0.0" : ((a / b) * 100).toFixed(1));

/** 用当前 rules.json 重算一期的全部结果 */
function computeAll() {
  const out = {};
  for (const v of data.vendors) {
    const values = Object.fromEntries(v.indicators.map((i) => [i.key, i.value]));
    const { scores, total } = computeScores(rules, values);
    const flex = applyFlexAdjustment(rules, total, v.flex_adjustments ?? []);
    const { level } = determineLevel(rules, v.city, flex.adjusted, values, { redline: v.redline });
    const monthly = values[rules.s_scale_gate.indicator] * entry.days;
    const est = estimateIncentive(rules, level, monthly, { redline: v.redline });
    out[v.vendor_code] = {
      city: v.city,
      level,
      total_score: Number(flex.adjusted.toFixed(2)),
      double_zero: adviceBranch(rules, scores)?.key === "double_zero",
      redline: !!v.redline,
      payout: est.frozen ? 0 : est.amount,
    };
  }
  return out;
}

const current = computeAll();

// 基线：文件优先；没有则用数据文件里的既有结果（V6 原始测算）
let baseline, baselineSource;
if (existsSync(baselinePath)) {
  const b = JSON.parse(readFileSync(baselinePath, "utf-8"));
  baseline = b.vendors;
  baselineSource = `${b.rules_version ?? "?"}（${b.saved_at ?? "?"} 留档）`;
} else {
  baseline = Object.fromEntries(data.vendors.map((v) => [v.vendor_code, {
    city: v.city, level: v.level, total_score: v.total_score,
    double_zero: !!v.double_zero, redline: !!v.redline, payout: null,
  }]));
  baselineSource = `${entry.file} 内既有测算结果`;
}

/* ---------- 1. 等级变动逐家 ---------- */
const changed = [];
for (const [code, cur] of Object.entries(current)) {
  const base = baseline[code];
  if (base && base.level !== cur.level) changed.push({ code, city: cur.city, from: base.level, to: cur.level });
}

/* ---------- 2. 分布与 SA 占比 ---------- */
const LEVELS = ["S", "A", "B", "C"];
const dist = (src) => {
  const byCity = {};
  for (const [code, r] of Object.entries(src)) {
    const c = (byCity[r.city] ??= { S: 0, A: 0, B: 0, C: 0 });
    c[r.level]++;
  }
  return byCity;
};
const distBase = dist(baseline), distCur = dist(current);
const sum = (d) => LEVELS.reduce((a, l) => a + (d[l] ?? 0), 0);

/* ---------- 3/4/5. 成本、双 0、红线 ---------- */
const costCur = Object.values(current).reduce((a, r) => a + r.payout, 0);
const costBase = Object.values(baseline).every((r) => r.payout === null)
  ? null
  : Object.values(baseline).reduce((a, r) => a + (r.payout ?? 0), 0);
const dzBase = Object.values(baseline).filter((r) => r.double_zero).length;
const dzCur = Object.values(current).filter((r) => r.double_zero).length;
const dzChanged = Object.entries(current)
  .filter(([code, r]) => baseline[code] && baseline[code].double_zero !== r.double_zero)
  .map(([code, r]) => `${code}（${baseline[code].double_zero ? "双0→正常" : "正常→双0"}）`);
const rlChanged = Object.entries(current)
  .filter(([code, r]) => baseline[code] && baseline[code].redline !== r.redline)
  .map(([code, r]) => `${code}（${baseline[code].redline ? "红线→非红线" : "非红线→红线"}）`);

/* ---------- 输出 ---------- */
console.log(`\n规则变更影响面 · ${entry.type === "weekly" ? "周度" : "月度"} ${entry.id}（${data.vendors.length} 家）`);
console.log(`规则版本：${rules.version} / status=${rules.status}｜基线来源：${baselineSource}`);
console.log("=".repeat(72));

console.log(`\n【1】等级变动：${changed.length} 家`);
if (changed.length) {
  for (const c of changed) console.log(`  ${c.code.padEnd(30)} ${c.city.padEnd(5)} ${c.from} → ${c.to}`);
} else {
  console.log("  无等级变动");
}

console.log(`\n【2】分布与 SA 占比`);
for (const city of Object.keys(distCur)) {
  const b = distBase[city] ?? { S: 0, A: 0, B: 0, C: 0 }, c = distCur[city];
  const nb = sum(b), nc = sum(c);
  console.log(`  ${city}: S${b.S}/A${b.A}/B${b.B}/C${b.C} → S${c.S}/A${c.A}/B${c.B}/C${c.C}` +
    `  ｜ SA ${pct(b.S + b.A, nb)}% → ${pct(c.S + c.A, nc)}%`);
}
const allB = LEVELS.map((l) => Object.values(baseline).filter((r) => r.level === l).length);
const allC = LEVELS.map((l) => Object.values(current).filter((r) => r.level === l).length);
console.log(`  合计: S${allB[0]}/A${allB[1]}/B${allB[2]}/C${allB[3]} → S${allC[0]}/A${allC[1]}/B${allC[2]}/C${allC[3]}` +
  `  ｜ SA ${pct(allB[0] + allB[1], data.vendors.length)}% → ${pct(allC[0] + allC[1], data.vendors.length)}%`);

console.log(`\n【3】月激励成本（演示口径：日均×${entry.days}天×单价，封顶 ${fmtMoney(rules.incentive.per_vendor_monthly_cap)}，红线冻结计 0）`);
console.log(costBase === null
  ? `  当前 ${fmtMoney(costCur)}（基线未含成本，无法对比——本次留档后下次可比）`
  : `  ${fmtMoney(costBase)} → ${fmtMoney(costCur)}（${costCur >= costBase ? "+" : ""}${fmtMoney(costCur - costBase)}）`);

console.log(`\n【4】双 0 分档：${dzBase} → ${dzCur} 家`);
if (dzChanged.length) dzChanged.forEach((x) => console.log(`  ${x}`));
else console.log("  无变动");

console.log(`\n【5】红线状态：${Object.values(baseline).filter((r) => r.redline).length} → ${Object.values(current).filter((r) => r.redline).length} 家`);
if (rlChanged.length) rlChanged.forEach((x) => console.log(`  ${x}`));
else console.log("  无变动（红线由数据侧的周度命中判定，规则改阈值不会追溯改变既有命中记录）");

if (saveBaseline) {
  writeFileSync(baselinePath, JSON.stringify({
    _readme: "规则变更后的等级基线留档。recalc/影响面报告以此为对比起点。",
    period: entry.id,
    rules_version: rules.version,
    rules_effective_from: rules.effective_from,
    saved_at: new Date().toISOString().slice(0, 10),
    vendors: current,
  }, null, 1), "utf-8");
  console.log(`\n✅ 新基线已留档：data/baseline_${entry.id}.json（${rules.version}）`);
  console.log("   记得在 PROGRESS.md 写明「基线因 V6x 规则变更更新，旧基线对应 V6」");
} else {
  console.log(`\n（核对无误后跑 --save-baseline 留档新基线）`);
}
