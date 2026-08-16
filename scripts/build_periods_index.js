// 生成 data/periods.json：扫描 data/vendors_*.json 产出可选评定期清单（月度 + 周度）。
// 新增一期数据后跑一次即可（bun scripts/build_periods_index.js），避免手维护清单走样。

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { daysInMonth } from "../src/engine/period.js";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(SITE, "data");

const files = readdirSync(DATA).filter((f) => /^vendors_.+\.json$/.test(f));
const monthly = [];
const weekly = [];

for (const file of files) {
  const d = JSON.parse(readFileSync(join(DATA, file), "utf-8"));
  const meta = d.meta ?? {};
  const isWeekly = meta.period_type === "weekly";
  if (isWeekly) {
    // meta.period 形如 "2026-W32（wk0803（2026-08-03 ~ 08-09））"
    const id = (meta.period.match(/^(\d{4}-W\d{2})/) ?? [])[1] ?? file;
    const wk = (meta.period.match(/wk(\d{4})/) ?? [])[1];
    const range = (meta.period.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{2}-\d{2})/) ?? []);
    weekly.push({
      id,
      file,
      type: "weekly",
      week_label: wk ? `wk${wk}` : id,
      range: range[1] ? `${range[1].slice(5)} ~ ${range[2]}` : null,
      month: range[1] ? range[1].slice(0, 7) : null,
      days: meta.days_in_period ?? 7,
      vendor_count: meta.vendor_count ?? d.vendors.length,
      disclaimer: true, // 周度=试算，页面必须标注非正式评级
    });
  } else {
    const id = meta.period_detail?.label ?? (meta.period ?? "").slice(0, 7);
    monthly.push({
      id,
      file,
      type: "monthly",
      weeks: meta.period_detail?.weeks ?? null,
      days: daysInMonth(id),
      vendor_count: meta.vendor_count ?? d.vendors.length,
      disclaimer: false,
    });
  }
}

monthly.sort((a, b) => b.id.localeCompare(a.id)); // 新→旧
weekly.sort((a, b) => b.id.localeCompare(a.id));

const out = {
  _readme: "由 scripts/build_periods_index.js 生成。月度=正式评级；周度=试算快照（不计入保护期与清退）。",
  _generated_at: new Date().toISOString().slice(0, 10),
  default: { type: "monthly", id: monthly[0]?.id ?? null },
  monthly,
  weekly,
};
writeFileSync(join(DATA, "periods.json"), JSON.stringify(out, null, 1), "utf-8");
console.log(`✓ periods.json：月度 ${monthly.length} 期（${monthly.map((m) => m.id).join(", ")}）｜周度 ${weekly.length} 期（${weekly.map((w) => w.week_label).join(", ")}）`);
