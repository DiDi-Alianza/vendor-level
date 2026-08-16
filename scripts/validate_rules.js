// 规则文件校验器：bun scripts/validate_rules.js（在 05_网站/ 下）
// 每次改 rules.json 必跑（与 recalc.js、bun test 并列）。
// 检查四类问题：
//   1. 启用指标权重和 == 1.0
//   2. changelog 每条声称的变更在文件里是否真实存在（“声称改了但没改”直接抓出）
//   3. 所有 *_key 引用的 i18n 键在 zh.json 里是否有中文
//   4. 指标 direction 与档位阈值方向是否自洽（含复合分项）
// 本脚本是校验器：断言里的期望值是对 changelog 声称内容的编码，不受“代码无业务字面值”铁律约束。

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const rules = JSON.parse(readFileSync(join(SITE, "data", "rules.json"), "utf-8"));
const zh = JSON.parse(readFileSync(join(SITE, "src", "i18n", "zh.json"), "utf-8"));

const errors = [];
const warnings = [];

/* ---------- 1. 权重和 ---------- */
const active = rules.indicators.filter((i) => i.enabled !== false);
const sum = active.reduce((a, i) => a + i.weight, 0);
if (Math.abs(sum - 1.0) > 1e-9) {
  errors.push(`权重和 = ${sum}，应为 1.0`);
}

/* ---------- 2. changelog 声称 vs 文件实况 ---------- */
const ind = (key) => rules.indicators.find((i) => i.key === key);
const CLAIMS = {
  "changelog.v6.credit_replaces_flex": () => !!ind("credit")?.composite,
  "changelog.v6.redline_added": () => !!rules.redline?.weekly_hit && !!rules.redline?.trigger,
  "changelog.v6.ontime_to_slot": () => !!ind("slot"),
  // 注：V6 原条目还声称「S 线全市场统一」，该半条已被 CR-20260814（S 拆分城）取代，
  // 故此处只校验仍然成立的部分——分城线存在。changelog 是历史记录，后续条目可以取代前面的。
  "changelog.v6.city_lines": () =>
    Object.entries(rules.level_lines?.by_city ?? {}).length >= 2 &&
    Object.values(rules.level_lines.by_city).every((l) => l.A !== undefined && l.C !== undefined),
  "changelog.v6.newrider_curp": () => !!ind("newrider"),
  "changelog.v6a.redline_cap": () => rules.redline?.level_cap === "B",
  "changelog.v6a.protection_rated": () => rules.new_vendor_protection?.rated_during_protection === true,
  "changelog.v6a.flex": () => rules.flex_adjustment?.max_abs === 10,
  "changelog.v6a.orders_perfect": () => (zh["indicator.orders"] ?? "").includes("完美单"),
  "changelog.v6b.flex_split": () =>
    !!rules.flex_adjustment?.components?.activity_bonus &&
    !!rules.flex_adjustment?.components?.penalty &&
    (rules.flex_adjustment?.components?.penalty?.no_double_penalty?.prohibited?.length ?? 0) >= 3,
  "changelog.v6b.orders_caliber": () =>
    ind("orders")?.unit === "完美单/日" && (ind("orders")?._note ?? "").includes("÷"),
  "changelog.v6b.d3r_naming": () => !!ind("d3r") && zh["indicator.d3r"] === "D-3R%",
  "changelog.v6b.blocked_rider": () =>
    ind("blocked_rider_rate")?.direction === "lower_better" &&
    (ind("blocked_rider_rate")?._note ?? "").includes("Anti-Fraud"),
  "changelog.v6b.newrider_real": () =>
    !ind("newrider")?.proxy_notice_key && (ind("newrider")?._note ?? "").includes("CURP"),
  "changelog.v6b.credit_unlock": () => ind("credit")?.input_type === "composite",
  // CR-20260814 A1–A8 + B1–B4
  "changelog.cr0814.drop_s_gate": () => rules.s_scale_gate?.enabled === false,
  "changelog.cr0814.s_by_city": () =>
    rules.level_lines.shared?.S === undefined &&
    Object.values(rules.level_lines.by_city).every((l) => typeof l.S === "number"),
  "changelog.cr0814.lines_recalibrated": () =>
    Object.values(rules.level_lines.by_city).every((l) => l.C < l.A && l.A < l.S),
  "changelog.cr0814.credit_overdue_only": () => {
    const comps = ind("credit")?.composite?.components ?? [];
    return comps.length === 1 && comps[0].key === "overdue_ratio" && comps[0].weight === 1.0;
  },
  "changelog.cr0814.slot_daily": () => (ind("slot")?._note ?? "").includes("按日聚合"),
  "changelog.cr0814.newrider_denominator": () =>
    (ind("newrider")?._note ?? "").includes("新招骑手") &&
    ind("newrider")?.tiers?.[0]?.gte === 70,
  "changelog.cr0814.natural_month": () => rules.evaluation_window?.type === "natural_month",
  // A10（二次收紧版）：满分档门槛恰为 0（占比 >0 拿不到满分、=0 仍满分），
  // 且 80/50 档已收紧到 ≤20 / <50——只验满分档会漏掉第二处改动
  "changelog.a10.credit_no_full_with_overdue": () => {
    const ov = ind("credit")?.composite?.components?.find((c) => c.key === "overdue_ratio");
    const tiers = ov?.tiers ?? [];
    const at = (score) => tiers.find((t) => t.score === score);
    return at(100)?.lte === 0 && at(80)?.lte === 20 && at(50)?.lt === 50 &&
      ind("credit").composite.no_debt_score === 100;
  },
  // A11：0 分档一律含边界。等价判定 = 每个指标「倒数第二档」用严格算子（gt / lt），
  // 这样边界值落不进它、只能落进 0 分档。d3r 本来就是 lt，一并覆盖。
  "changelog.a11.zero_tier_inclusive": () =>
    rules.indicators.every((i) => {
      const tiers = i.composite
        ? i.composite.components.flatMap((c) => c.tiers)
        : i.tiers ?? [];
      if (!tiers.length) return true;
      const fifty = tiers.find((t) => t.score === 50);
      return !fifty || "gt" in fifty || "lt" in fifty;
    }),
};

for (const entry of rules.changelog) {
  for (const key of entry.changes_keys ?? []) {
    const check = CLAIMS[key];
    if (!check) {
      warnings.push(`changelog 变更「${key}」没有对应的自动校验规则（无法验证声称是否属实）`);
    } else if (!check()) {
      errors.push(`changelog 声称「${zh[key] ?? key}」，但文件里没有对应变更（键 ${key} 校验失败）`);
    }
  }
}

/* ---------- 3. i18n 键覆盖 ---------- */
const referencedKeys = new Set();
(function collect(node) {
  if (Array.isArray(node)) return node.forEach(collect);
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k.endsWith("_key") && typeof v === "string") referencedKeys.add(v);
      if (k.endsWith("_keys") && Array.isArray(v)) v.forEach((x) => referencedKeys.add(x));
      collect(v);
    }
  }
})(rules);
for (const i of rules.indicators) {
  referencedKeys.add(`indicator.${i.key}`);
  referencedKeys.add(`indicator.${i.key}.desc`);
  for (const c of i.composite?.components ?? []) referencedKeys.add(c.name_key);
}
for (const key of referencedKeys) {
  if (zh[key] === undefined) errors.push(`i18n 缺键：rules.json 引用了「${key}」，zh.json 里没有中文`);
}

/* ---------- 4. direction 与档位方向自洽 ---------- */
function checkTiers(label, direction, tiers) {
  let prev = null;
  tiers.forEach((tier, i) => {
    const kind = "gte" in tier ? "gte" : "gt" in tier ? "gt"
      : "lt" in tier ? "lt" : "lte" in tier ? "lte" : null;
    if (!kind) return errors.push(`${label} 第 ${i + 1} 档没有阈值字段（gte/gt/lt/lte）`);
    // A11：0 分档含边界 → higher_better 允许 gt、lower_better 允许 lt，但不能跨方向混用
    if (direction === "higher_better" && kind !== "gte" && kind !== "gt") {
      errors.push(`${label} 是 higher_better，第 ${i + 1} 档却用 ${kind}`);
    }
    if (direction === "lower_better" && (kind === "gte" || kind === "gt")) {
      errors.push(`${label} 是 lower_better，第 ${i + 1} 档却用 ${kind}`);
    }
    const v = tier[kind];
    if (v !== null && prev !== null) {
      if (direction === "higher_better" && v >= prev) errors.push(`${label} 档位阈值应严格递减，第 ${i + 1} 档 ${v} ≥ 前档 ${prev}`);
      if (direction === "lower_better" && v <= prev) errors.push(`${label} 档位阈值应严格递增，第 ${i + 1} 档 ${v} ≤ 前档 ${prev}`);
    }
    if (v !== null) prev = v;
  });
  // 得分应从高到低
  let prevS = null;
  tiers.forEach((tier, i) => {
    if (prevS !== null && tier.score >= prevS) errors.push(`${label} 档位得分应严格递减，第 ${i + 1} 档 ${tier.score} ≥ 前档 ${prevS}`);
    prevS = tier.score;
  });
}
for (const i of rules.indicators) {
  if (i.composite && !Array.isArray(i.tiers)) {
    for (const c of i.composite.components) checkTiers(`${i.key}·${c.key}`, c.direction, c.tiers);
  } else {
    checkTiers(i.key, i.direction, i.tiers);
  }
}

/* ---------- 结构性约定 ---------- */
if (rules.period !== undefined) errors.push("rules.json 不应包含 period（评定期属于数据文件，2026-08-13 迁出）");
for (const [city, l] of Object.entries(rules.level_lines?.by_city ?? {})) {
  // S 线兼容两种结构：by_city[城市].S（CR-20260814 起，分城）或 shared.S（旧结构）
  const sLine = l.S ?? rules.level_lines.shared?.S;
  if (sLine === undefined) errors.push(`${city} 缺 S 线（既无 by_city.S 也无 shared.S）`);
  else if (!(l.C < l.A && l.A < sLine)) errors.push(`${city} 分数线顺序错误：需 C < A < S（当前 C=${l.C} A=${l.A} S=${sLine}）`);
}

/* ---------- 输出 ---------- */
for (const w of warnings) console.warn("⚠️ " + w);
if (errors.length) {
  console.error(`\n❌ ${errors.length} 处校验失败:`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`✅ validate_rules 全部通过（权重和 / changelog 实况 ${Object.keys(CLAIMS).length} 项 / i18n 覆盖 ${referencedKeys.size} 键 / 档位方向自洽）`);
