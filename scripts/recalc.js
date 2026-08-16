// 重算校验：读 rules.json + vendors_2026_07.json 原始值 → 用 src/engine 重算六项得分、综合分、等级，
// 与测算表提取值逐家比对。运行：bun scripts/recalc.js（在 05_网站/ 目录下）
// 引擎与页面共用 src/engine/rules.js —— 本脚本不含任何业务字面值。

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { validateRules, computeScores, determineLevel, adviceBranch, applyFlexAdjustment } from "../src/engine/rules.js";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const rules = validateRules(JSON.parse(readFileSync(join(SITE, "data", "rules.json"), "utf-8")));
const data = JSON.parse(readFileSync(join(SITE, "data", "vendors_2026_07.json"), "utf-8"));

// 测算表 total_score 保留 1 位小数，比对容差取 0.05
const TOTAL_TOLERANCE = 0.05;

const mismatches = []; // 核心：单项得分 / 综合分 / 等级 —— 有一条即失败
const flagWarnings = []; // 辅助标记（S门槛拦截、双0）：不一致时列出等人工确认，不判失败
const dist = {}; // city → level → count
let maxTotalDiff = 0;

for (const v of data.vendors) {
  const values = Object.fromEntries(v.indicators.map((i) => [i.key, i.value]));
  const { scores, total } = computeScores(rules, values);
  const flex = applyFlexAdjustment(rules, total, v.flex_adjustments ?? []);
  const { level, sScaleGateBlocked } = determineLevel(rules, v.city, flex.adjusted, values, { redline: v.redline });
  const branch = adviceBranch(rules, scores);

  for (const ind of v.indicators) {
    if (scores[ind.key] !== ind.score) {
      mismatches.push(`${v.vendor_code} 指标 ${ind.key}: 重算 ${scores[ind.key]} ≠ 测算 ${ind.score} (原始值 ${ind.value})`);
    }
  }
  const diff = Math.abs(total - v.total_score);
  maxTotalDiff = Math.max(maxTotalDiff, diff);
  if (diff > TOTAL_TOLERANCE) {
    mismatches.push(`${v.vendor_code} 综合分: 重算 ${total.toFixed(2)} ≠ 测算 ${v.total_score}`);
  }
  if (level !== v.level) {
    mismatches.push(`${v.vendor_code} 等级: 重算 ${level} ≠ 测算 ${v.level} (综合分 ${total.toFixed(2)})`);
  }
  if (sScaleGateBlocked !== v.s_scale_gate_blocked) {
    flagWarnings.push(`${v.vendor_code} S规模门槛拦截标记: 重算 ${sScaleGateBlocked} ≠ 测算 ${v.s_scale_gate_blocked} (综合分 ${total.toFixed(2)}, S线 ${rules.level_lines.shared.S})`);
  }
  const isDoubleZero = branch?.key === "double_zero";
  if (isDoubleZero !== v.double_zero) {
    flagWarnings.push(`${v.vendor_code} 双0标记: 重算 ${isDoubleZero} ≠ 测算 ${v.double_zero}`);
  }

  dist[v.city] ??= {};
  dist[v.city][level] = (dist[v.city][level] ?? 0) + 1;
}

const n = data.vendors.length;
console.log(`比对 ${n} 家，一致 ${n - new Set(mismatches.map((m) => m.split(" ")[0])).size} 家`);
console.log(`综合分最大偏差: ${maxTotalDiff.toFixed(4)}`);
console.log("\n等级分布（重算）:");
for (const [city, levels] of Object.entries(dist)) {
  const totalCity = Object.values(levels).reduce((a, b) => a + b, 0);
  const sa = ((levels.S ?? 0) + (levels.A ?? 0)) / totalCity;
  console.log(`  ${city}: S${levels.S ?? 0} A${levels.A ?? 0} B${levels.B ?? 0} C${levels.C ?? 0} | SA 占比 ${(sa * 100).toFixed(1)}%`);
}
console.log("\n（月激励成本需逐商完美单量，data/ 中暂无该字段，本脚本不输出成本项）");

if (flagWarnings.length) {
  console.warn(`\n⚠️ 辅助标记不一致 ${flagWarnings.length} 处（不判失败，等人工确认，见 PROGRESS.md）:`);
  for (const m of flagWarnings) console.warn("  " + m);
}
if (mismatches.length) {
  console.error(`\n❌ 核心比对 ${mismatches.length} 处不一致:`);
  for (const m of mismatches) console.error("  " + m);
  process.exit(1);
} else {
  console.log(`\n✅ 核心比对 ${n}/${n} 全部一致（六项得分、综合分、等级）`);
}
