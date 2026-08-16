// 导入管道：本地 data/*.json → Supabase（bun scripts/supabase_import.js [periodId ...]）
// 按 data/periods.json 遍历全部期（月度=正式评级 / 周度=试算快照），可传期号只导指定期。
// 幂等：全部 upsert（on_conflict 主键）。含：排名/百分位预计算、分布与等级聚合、rules 拆分公示/内部。
// 依赖：scripts/.supabase_secrets.json（Secret key，绕过 RLS——仅本地运行，绝不进前端）。

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { validateRules } from "../src/engine/rules.js";
import { buildRankingStats, adjustedScore, BIN_SIZE, LEVELS } from "../src/engine/ranking.js";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const secrets = JSON.parse(readFileSync(join(SITE, "scripts", ".supabase_secrets.json"), "utf-8"));
const rules = validateRules(JSON.parse(readFileSync(join(SITE, "data", "rules.json"), "utf-8")));
const profileData = JSON.parse(readFileSync(join(SITE, "data", "vendor_profile.json"), "utf-8"));
const index = JSON.parse(readFileSync(join(SITE, "data", "periods.json"), "utf-8"));

const HEADERS = {
  apikey: secrets.service_role_key,
  Authorization: `Bearer ${secrets.service_role_key}`,
  "Content-Type": "application/json",
};
const BIN = 10;
const only = process.argv.slice(2);

const pendingMigrations = new Set();

async function post(table, rows, onConflict) {
  return fetch(`${secrets.url}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
}

async function upsert(table, rows, onConflict) {
  if (!rows.length) return;
  let res = await post(table, rows, onConflict);
  if (!res.ok) {
    const body = await res.text();
    // 库里还没有该列（迁移未执行）→ 剔除该列重试并告警。
    // 理由：库里留着旧口径数据比缺一列危害更大；但绝不静默——列进 pendingMigrations 并在末尾醒目提示。
    const m = body.match(/Could not find the '([^']+)' column/);
    if (m) {
      const col = m[1];
      pendingMigrations.add(col);
      const stripped = rows.map((r) => { const c = { ...r }; delete c[col]; return c; });
      res = await post(table, stripped, onConflict);
      if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
      console.log(`  ⚠️ ${table}: ${rows.length} 行（已跳过缺失列 ${col}）`);
      return;
    }
    throw new Error(`${table}: ${res.status} ${body}`);
  }
  console.log(`  ✓ ${table}: ${rows.length} 行`);
}


// ---------- 商户档案（剔除 _issues 等内部审计字段；不含邮箱/电话/银行账号） ----------
await upsert("vg_vendor_profile", profileData.profiles.map((p) => ({
  vendor_code: p.vendor_code,
  display_name: p.display_name,
  city: p.city,
  rm_name: p.rm,
  first_order_date: p.first_order_date,
  active_status: p.active_status,
})), "vendor_code");

// ---------- 逐期导入 ----------
const entries = [...index.monthly, ...index.weekly].filter((e) => !only.length || only.includes(e.id));
if (!entries.length) {
  console.error(`未匹配到期号：${only.join(", ")}。可选：${[...index.monthly, ...index.weekly].map((e) => e.id).join(", ")}`);
  process.exit(1);
}

for (const entry of entries) {
  const data = JSON.parse(readFileSync(join(SITE, "data", entry.file), "utf-8"));
  const period = entry.id;
  console.log(`\n[${entry.type} ${period}]${entry.type === "weekly" ? `（${entry.week_label} 试算快照）` : ""}`);

  await upsert("vg_periods", [{
    period,
    weeks: entry.weeks ?? null,
    type: entry.type,
    week_label: entry.week_label ?? null,
    date_range: entry.range ?? null,
    month: entry.month ?? period,
    days: entry.days,
    vendor_count: entry.vendor_count,
    disclaimer: !!entry.disclaimer,
  }], "period");

  // 排名/分布走共享模块（src/engine/ranking.js），与页面 local 源同一算法，杜绝口径漂移
  const stats = buildRankingStats(rules, data.vendors);
  const scoreRows = data.vendors.map((v) => ({
    period,
    period_type: entry.type,
    vendor_code: v.vendor_code,
    city: v.city,
    level: v.level,
    level_official_v1: v.level_official_v1 ?? null,
    level_change: v.level_change ?? null,
    total_score: v.total_score,
    redline: v.redline ?? false,
    // 周度只能判单周命中；月度触发状态放 redline 字段（口径见 rules.redline）
    redline_week_hit: entry.type === "weekly" ? (v.redline_week_hit ?? null) : null,
    indicators: v.indicators,
    ...stats.perVendor[v.vendor_code],
  }));
  await upsert("vg_vendor_scores", scoreRows, "period,vendor_code");

  // 灵活分流水（演示数据暂无；结构就位，有则一并入库）
  const flexRows = data.vendors.flatMap((v) => (v.flex_adjustments ?? []).map((f) => ({
    period, vendor_code: v.vendor_code, type: f.type, value: f.value, reason: f.reason_key ?? f.reason ?? "",
  })));
  if (flexRows.length) await upsert("vg_flex_adjustments", flexRows, "id");

  // 聚合表：全网 + 分城（无任何身份信息，Vendor 端读这个画分布图）
  const distRows = Object.entries(stats.scopes).flatMap(([scope, s]) =>
    s.bins.map((b) => ({ period, scope, bin_start: b.bin_start, cnt: b.cnt })));
  const lvlRows = Object.entries(stats.scopes).flatMap(([scope, s]) =>
    LEVELS.map((level) => ({ period, scope, level, cnt: s.levelCounts[level] ?? 0 })));
  await upsert("vg_score_distribution", distRows, "period,scope,bin_start");
  await upsert("vg_level_counts", lvlRows, "period,scope,level");
}

// ---------- rules 拆分：公示（登录可读）vs 内部（仅 admin：备选线/SA 目标） ----------
const pub = structuredClone(rules);
const internal = {
  level_lines_alternatives: pub.level_lines.alternatives ?? null,
  design_target_sa_ratio: pub.level_lines.design_target_sa_ratio ?? null,
};
delete pub.level_lines.alternatives;
delete pub.level_lines.design_target_sa_ratio;

console.log("");
for (const [table, row] of [
  ["vg_rules_public", { version: pub.version, status: pub.status, effective_from: pub.effective_from, body: pub }],
  ["vg_rules_internal", { body: internal }],
]) {
  await fetch(`${secrets.url}/rest/v1/${table}?id=gte.0`, { method: "DELETE", headers: HEADERS });
  const res = await fetch(`${secrets.url}/rest/v1/${table}`, {
    method: "POST", headers: HEADERS, body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  console.log(`  ✓ ${table}: 已刷新`);
}

console.log(`\n✅ 导入完成：${entries.length} 期（${entries.map((e) => e.id).join(", ")}）`);
if (pendingMigrations.size) {
  console.log(`\n⚠️⚠️ 以下列在库里不存在，本次导入已跳过：${[...pendingMigrations].join(", ")}`);
  console.log("   → 需在 Supabase SQL Editor 执行对应迁移（supabase/migration_003_rank_level.sql）后重跑本脚本。");
  console.log("   → 在此之前，SOURCE=supabase 模式下这些字段为空，相关展示会降级（不会显示错误数字）。");
}
