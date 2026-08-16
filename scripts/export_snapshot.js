// 数据备份导出：bun scripts/export_snapshot.js [period]
// 把 Supabase 里全部 vg_* 评级数据导出为本地快照（json + xlsx 各一份），
// 存到 backups/YYYY-MM/。每月出完当月评级后手动跑一次。
// 动机：Supabase Pro 的每日备份在服务商侧；本地快照自己能直接打开，降级免费版也不断档。
// 使用 service_role（绕过 RLS 读全量）——仅本地运行；backups/ 已在 .gitignore。

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const secrets = JSON.parse(readFileSync(join(SITE, "scripts", ".supabase_secrets.json"), "utf-8"));

const HEADERS = { apikey: secrets.service_role_key, Authorization: `Bearer ${secrets.service_role_key}` };

const TABLES = [
  "vg_periods", "vg_vendor_profile", "vg_vendor_scores", "vg_flex_adjustments",
  "vg_score_distribution", "vg_level_counts",
  "vg_rules_public", "vg_rules_internal", "vg_rules_history", "vg_user_roles",
];

async function fetchAll(table) {
  // PostgREST 默认单页上限 1000，用 Range 翻页取全量
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${secrets.url}/rest/v1/${table}?select=*`, {
      headers: { ...HEADERS, Range: `${from}-${from + 999}` },
    });
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

const tables = {};
for (const t of TABLES) {
  tables[t] = await fetchAll(t);
  console.log(`✓ ${t}: ${tables[t].length} 行`);
}

// 快照月份：命令行参数优先，否则取 vg_periods 里最新一期
const period = process.argv[2] ?? tables.vg_periods.map((p) => p.period).sort().at(-1);
if (!/^\d{4}-\d{2}$/.test(period ?? "")) {
  console.error("无法确定快照月份（vg_periods 为空且未传参数）。用法：bun scripts/export_snapshot.js 2026-07");
  process.exit(1);
}

const dir = join(SITE, "backups", period);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const jsonPath = join(dir, `snapshot_${period}_${stamp}.json`);
const xlsxPath = join(dir, `snapshot_${period}_${stamp}.xlsx`);

writeFileSync(jsonPath, JSON.stringify({ exported_at: new Date().toISOString(), period, tables }, null, 1), "utf-8");
console.log(`✓ JSON → ${jsonPath}`);

// xlsx 由 Python openpyxl 生成（npm 不可达，装不了 js 的 xlsx 库）
const py = Bun.spawnSync(["python", join(SITE, "scripts", "make_snapshot_xlsx.py"), jsonPath, xlsxPath], {
  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
});
if (py.exitCode !== 0) {
  console.error(`xlsx 生成失败：${py.stderr.toString()}`);
  process.exit(1);
}
console.log(py.stdout.toString().trim());
console.log(`\n✅ 快照完成：${dir}`);
