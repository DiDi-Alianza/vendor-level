// 从原始值文件生成评级文件：bun scripts/build_vendors.js
//   data/_monthly_values_<period>.json / _weekly_values_<period>.json  →  data/vendors_<period>.json
// 用 src/engine 现算得分/综合分/等级/双0/派生标记，与页面、recalc、导入管道同一实现。
// 分析侧改口径后重新取数 → 跑本脚本 → 跑 validate_rules/recalc/test/test_rls + rule_change_impact。

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  validateRules, computeScores, determineLevel, adviceBranch,
  applyFlexAdjustment, activeIndicators, isCompositeInput,
} from "../src/engine/rules.js";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(SITE, "data");
const rules = validateRules(JSON.parse(readFileSync(join(DATA, "rules.json"), "utf-8")));

/** 红线由周度欠款快照独立判定，不在指标原始值文件里 → 从上一版评级文件承继 */
function inheritedFlags(outFile) {
  const p = join(DATA, outFile);
  if (!existsSync(p)) return {};
  const prev = JSON.parse(readFileSync(p, "utf-8"));
  return Object.fromEntries(prev.vendors.map((v) => [v.vendor_code, {
    redline: v.redline ?? false,
    redline_week_hit: v.redline_week_hit ?? null,
    level_official_v1: v.level_official_v1 ?? null,
  }]));
}

const LEVEL_ORDER = ["S", "A", "B", "C"];

function build(valuesFile, outFile) {
  const src = JSON.parse(readFileSync(join(DATA, valuesFile), "utf-8"));
  const inherited = inheritedFlags(outFile);
  const isWeekly = src.meta.period_type === "weekly";
  const periodId = isWeekly ? (src.meta.period.match(/^(\d{4}-W\d{2})/) ?? [])[1] ?? src.meta.period
    : src.meta.period;

  const vendors = src.vendors.map((row) => {
    const values = row.values;
    const { scores, contributions, total } = computeScores(rules, values);
    const flex = applyFlexAdjustment(rules, total, row.flex_adjustments ?? []);
    const inh = inherited[row.vendor_code] ?? {};
    const redline = isWeekly ? false : (inh.redline ?? false);
    const { level, sScaleGateBlocked, levelBeforeCap } =
      determineLevel(rules, row.city, flex.adjusted, values, { redline });
    const branch = adviceBranch(rules, scores);
    const v1 = row.official_level_v1 ?? inh.level_official_v1 ?? null;

    return {
      vendor_code: row.vendor_code,
      city: row.city,
      ...(v1 ? { level_official_v1: v1 } : {}),
      level,
      ...(level !== levelBeforeCap ? { level_before_cap: levelBeforeCap } : {}),
      level_change: v1 ? (LEVEL_ORDER.indexOf(level) < LEVEL_ORDER.indexOf(v1) ? "↑"
        : LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(v1) ? "↓" : null) : null,
      total_score: Number(flex.adjusted.toFixed(1)),
      lines: { ...rules.level_lines.shared, ...rules.level_lines.by_city[row.city] },
      redline,
      ...(isWeekly ? { redline_week_hit: row.redline_week_hit ?? null } : {}),
      s_scale_gate_blocked: sScaleGateBlocked,
      double_zero: branch?.key === "double_zero",
      indicators: activeIndicators(rules).map((rule) => ({
        key: rule.key,
        name_key: rule.name_key,
        weight: rule.weight,
        value: values[rule.key],
        unit: rule.unit,
        score: scores[rule.key],
        contribution: Number(contributions[rule.key].toFixed(2)),
        ...(isCompositeInput(rule)
          ? { composite: rule.composite.components.map((c) => ({ key: c.key, weight: c.weight })) }
          : { tiers: rule.tiers }),
      })),
      raw: row.raw ?? undefined,
      issues: row.issues?.length ? row.issues : undefined,
    };
  });

  const out = {
    meta: {
      period: periodId,
      period_detail: {
        label: periodId,
        weeks: isWeekly ? (src.meta.period_label ?? null) : null,
        _note: "评定期属于数据文件，不属于规则。",
      },
      period_type: src.meta.period_type,
      period_label: src.meta.period_label,
      days_in_period: src.meta.days_in_period,
      vendor_count: vendors.length,
      source: valuesFile,
      engine: "src/engine/rules.js（与页面、recalc、导入管道同一实现）",
      model_version: `${rules.version} / status=${rules.status} / effective_from=${rules.effective_from}`,
      change_request: src.meta.change_request ?? null,
      caliber: src.meta.caliber ?? src.meta.sources ?? null,
      ...(isWeekly ? { disclaimer: src.meta.disclaimer, redline_note: src.meta.redline_note } : {}),
      redline_provenance: isWeekly
        ? "周度只判 redline_week_hit（单周命中），触发需当月≥2次且月末仍命中，单周无法判定"
        : "红线标记承继自上一版评级文件（由周度欠款快照独立判定，本次口径变更未涉及）",
      data_issues: src.meta.data_issues ?? [],
    },
    vendors,
  };
  writeFileSync(join(DATA, outFile), JSON.stringify(out, null, 1), "utf-8");

  // 分布与成本速报（供与变更单 §F 对照）
  const byCity = {};
  for (const v of vendors) {
    const c = (byCity[v.city] ??= { S: 0, A: 0, B: 0, C: 0 });
    c[v.level]++;
  }
  const days = src.meta.days_in_period;
  const gateKey = rules.s_scale_gate.indicator;
  let cost = 0, capped = [];
  for (const v of vendors) {
    const rate = rules.incentive.rates[v.level];
    if (!rate || v.redline) continue;
    const monthly = v.indicators.find((i) => i.key === gateKey).value * days;
    const raw = monthly * rate;
    const amt = Math.min(raw, rules.incentive.per_vendor_monthly_cap);
    if (raw > rules.incentive.per_vendor_monthly_cap) capped.push(v.vendor_code);
    cost += amt;
  }
  const tot = { S: 0, A: 0, B: 0, C: 0 };
  for (const v of vendors) tot[v.level]++;
  const n = vendors.length;

  console.log(`\n[${outFile}] ${n} 家`);
  for (const [city, c] of Object.entries(byCity)) {
    const cn = c.S + c.A + c.B + c.C;
    console.log(`  ${city}: S${c.S}/A${c.A}/B${c.B}/C${c.C}  SA ${(((c.S + c.A) / cn) * 100).toFixed(0)}%`);
  }
  console.log(`  合计: S${tot.S}/A${tot.A}/B${tot.B}/C${tot.C}  SA ${(((tot.S + tot.A) / n) * 100).toFixed(0)}%`);
  console.log(`  月激励成本: MX$${Math.round(cost).toLocaleString("en-US")}（${(cost / 10000).toFixed(1)} 万）${capped.length ? ` · 触顶 ${capped.join(",")}` : " · 无商触顶"}`);
  console.log(`  双 0 分档: ${vendors.filter((v) => v.double_zero).length} 家 · 红线: ${vendors.filter((v) => v.redline).length} 家`);
  const s = vendors.filter((v) => v.level === "S").sort((a, b) => b.total_score - a.total_score);
  console.log(`  S 名单: ${s.map((v) => `${v.vendor_code.replace(/DIDI.*$/, "")} ${v.total_score}(${v.city})`).join("、") || "无"}`);
}

const all = readdirSync(DATA).filter((f) => /^_(monthly|weekly)_values_.+\.json$/.test(f));
// 可选参数：只重建指定期次（如 `bun scripts/build_vendors.js 2026-07 2026-W32`）。
// 不传则全部重建——期次多了以后，只改一期规则也要等全量跑完，没必要。
const only = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
// meta.partial = true 的期次源数据不全（如 4–6 月缺 slot/credit）→ 不参与评级，跳过并显式说明
const files = [];
for (const f of all) {
  const meta = JSON.parse(readFileSync(join(DATA, f), "utf-8")).meta ?? {};
  if (only.length && !only.some((p) => f.includes(p))) continue;
  if (meta.partial) {
    console.log(`⏭  跳过 ${f}：meta.partial=true（源数据不全，不可用于算等级）`);
    continue;
  }
  files.push(f);
}
if (!files.length) { console.error("data/ 下没有可用的 _monthly_values_*.json / _weekly_values_*.json"); process.exit(1); }
const gaps = [];
for (const f of files) {
  const m = f.match(/^_(?:monthly|weekly)_values_(.+)\.json$/);
  const period = m[1];
  const out = `vendors_${period.replace(/-/g, "_").toLowerCase()}.json`;
  try {
    build(f, out);
  } catch (e) {
    // 指标缺值不静默补 0（铁律 15/17）：整期作废并报出来，等分析侧补数，
    // 但不让一期的缺口连坐其他期——否则改一次规则就没法重建任何期次。
    if (e.code === "engine.value_missing") {
      gaps.push({ period, indicator: e.params?.indicator });
      console.log(`⚠  跳过 ${f}：指标「${e.params?.indicator}」有商缺值，该期不重建（不补 0、不猜）`);
      continue;
    }
    throw e;
  }
}
if (gaps.length) {
  console.log(`\n⚠ 以下期次因数据缺口未重建，需分析侧补数后再跑：`);
  for (const g of gaps) console.log(`   ${g.period} —— 缺 ${g.indicator}`);
}
console.log("\n✅ 评级文件已重建。接下来：bun scripts/build_periods_index.js → 四件套 → rule_change_impact");
