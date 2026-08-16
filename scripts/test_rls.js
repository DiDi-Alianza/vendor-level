// RLS 越权测试（bun scripts/test_rls.js）——每次改表或改策略必跑。
// 关键认知：RLS 是静默过滤，不报错。配错时页面看起来完全正常（前端也在过滤），
// 所以断言必须是「返回 0 行」而不是「报错」。
// 前置：migration_001/002 已执行、supabase_import.js 已导入、supabase_setup_users.js 已建号。
// 多期（月度+周度）：行数断言一律按期做，另加跨期断言防「换一期就能看到别人」。

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const secrets = JSON.parse(readFileSync(join(SITE, "scripts", ".supabase_secrets.json"), "utf-8"));
const profileData = JSON.parse(readFileSync(join(SITE, "data", "vendor_profile.json"), "utf-8"));
const index = JSON.parse(readFileSync(join(SITE, "data", "periods.json"), "utf-8"));

// 库里有多期（月度+周度）→ 断言按期做，并额外验证跨期也不越权
const periods = [...index.monthly, ...index.weekly].map((e) => ({
  id: e.id,
  type: e.type,
  data: JSON.parse(readFileSync(join(SITE, "data", e.file), "utf-8")),
}));
const main = periods.find((p) => p.type === "monthly") ?? periods[0];
const vendorsData = main.data;

// 身份绑定从数据库读，不假设数据文件顺序——重建数据后文件里第一家会变，
// 而测试账号的绑定不变；写死顺序会让测试在数据重建后误报（2026-08-14 踩过）。
let vendorA, vendorB, rmName;
const isRoster = (code) => profileData.profiles.find((p) => p.vendor_code === code)?.rm === rmName;
/** 某期 RM 应可见的家数 = 该期内（名下 ∪ S 级） */
const rmVisibleIn = (p) => p.data.vendors.filter((v) => isRoster(v.vendor_code) || v.level === "S").length;
const totalAllPeriods = periods.reduce((n, p) => n + p.data.vendors.length, 0);

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
};

async function signIn(email) {
  const res = await fetch(`${secrets.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: secrets.anon_key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: secrets.test_password }),
  });
  if (!res.ok) throw new Error(`登录失败 ${email}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function q(token, pathAndQuery) {
  const res = await fetch(`${secrets.url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: secrets.anon_key, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { error: res.status, rows: [] };
  return { rows: await res.json() };
}

async function write(token, table, body) {
  const res = await fetch(`${secrets.url}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: secrets.anon_key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

/* ---------- 先解析各测试账号的实际绑定（每个账号只能读到自己那行 user_roles） ---------- */
const ta = await signIn("test-vendor-a@alianza-demo.example.com");
{
  const rows = await q(ta, "vg_user_roles?select=role,vendor_code,rm_name");
  vendorA = rows.rows[0]?.vendor_code;
  if (!vendorA) { console.error("❌ test-vendor-a 未绑定 vendor_code，先跑 supabase_setup_users.js"); process.exit(1); }
}
{
  const tb = await signIn("test-vendor-b@alianza-demo.example.com");
  const rows = await q(tb, "vg_user_roles?select=vendor_code");
  vendorB = rows.rows[0]?.vendor_code;
}
{
  const tr0 = await signIn("test-rm@alianza-demo.example.com");
  const rows = await q(tr0, "vg_user_roles?select=rm_name");
  rmName = rows.rows[0]?.rm_name;
}
console.log(`\n[绑定] vendor_a=${vendorA} ｜ vendor_b=${vendorB} ｜ rm=${rmName}`);

/* ---------- Vendor A：只能看见自己 ---------- */
console.log(`\n[vendor_a = ${vendorA}]`);
{
  const r1 = await q(ta, `vg_vendor_scores?vendor_code=eq.${encodeURIComponent(vendorB)}`);
  check("查 vendor_b 的评级 → 0 行", r1.rows.length === 0, `实际 ${r1.rows.length} 行`);
  for (const p of periods) {
    const rp = await q(ta, `vg_vendor_scores?select=vendor_code&period=eq.${encodeURIComponent(p.id)}`);
    const inPeriod = p.data.vendors.some((v) => v.vendor_code === vendorA) ? 1 : 0;
    check(`${p.id} 期内 select → ${inPeriod} 行（仅自己）`,
      rp.rows.length === inPeriod && rp.rows.every((r) => r.vendor_code === vendorA), `实际 ${rp.rows.length} 行`);
  }
  const r2 = await q(ta, "vg_vendor_scores?select=vendor_code");
  check("跨全部期 select → 每一行都是自己（无他商泄漏）",
    r2.rows.length > 0 && r2.rows.every((r) => r.vendor_code === vendorA),
    `实际 ${r2.rows.length} 行，含他商 ${r2.rows.filter((r) => r.vendor_code !== vendorA).length} 行`);
  const r3 = await q(ta, "vg_vendor_profile?select=vendor_code");
  check("profile 全表 → 仅自己 1 行", r3.rows.length === 1 && r3.rows[0].vendor_code === vendorA, `实际 ${r3.rows.length} 行`);
  const r4 = await q(ta, "vg_rules_internal?select=id");
  check("rules_internal → 0 行（定线思路不可见）", r4.rows.length === 0, `实际 ${r4.rows.length}`);
  const r5 = await q(ta, "vg_rules_history?select=id");
  check("rules_history → 0 行", r5.rows.length === 0, `实际 ${r5.rows.length}`);
  const w = await write(ta, "vg_vendor_scores", [{ period: "2099-01", vendor_code: vendorA, city: "CDMX", level: "S", total_score: 100, indicators: [] }]);
  check("写入 vendor_scores → 拒绝", !w);
  const r6 = await q(ta, "vg_score_distribution?select=cnt");
  check("聚合分布可读", r6.rows.length > 0);
  const r7 = await q(ta, "vg_rules_public?select=version");
  check("公示规则可读", r7.rows.length === 1);
  const r8 = await q(ta, "vg_user_roles?select=role");
  check("user_roles → 仅自己 1 行", r8.rows.length === 1 && r8.rows[0].role === "vendor", `实际 ${r8.rows.length}`);
}

/* ---------- RM：名下 + 全部 S，看不到其他 ---------- */
console.log(`\n[rm = ${rmName}，名下 ${profileData.profiles.filter((p) => p.rm === rmName).length} 家；各期应可见：${
  periods.map((p) => `${p.id}=${rmVisibleIn(p)}`).join(" / ")}]`);
const tr = await signIn("test-rm@alianza-demo.example.com");
{
  for (const p of periods) {
    const expected = rmVisibleIn(p);
    const rp = await q(tr, `vg_vendor_scores?select=vendor_code,level&period=eq.${encodeURIComponent(p.id)}`);
    check(`${p.id} 期内可见 = 名下∪S = ${expected} 行`, rp.rows.length === expected, `实际 ${rp.rows.length}`);
  }
  const r1 = await q(tr, "vg_vendor_scores?select=vendor_code,level");
  const foreign = r1.rows.filter((row) => row.level !== "S" && !isRoster(row.vendor_code));
  check("跨全部期无任何非名下非 S 行", foreign.length === 0, `泄漏 ${foreign.length} 行`);
  const r2 = await q(tr, "vg_rules_internal?select=id");
  check("rules_internal → 0 行", r2.rows.length === 0);
  const w = await write(tr, "vg_flex_adjustments", [{ period: "2099-01", vendor_code: vendorA, type: "penalty", value: -1, reason: "x" }]);
  check("写入 flex → 拒绝", !w);
}

/* ---------- Ops：全量只读 ---------- */
console.log("\n[ops]");
const to = await signIn("test-ops@alianza-demo.example.com");
{
  const r1 = await q(to, "vg_vendor_scores?select=vendor_code");
  check(`scores 全量 ${totalAllPeriods} 行（各期之和）`, r1.rows.length === totalAllPeriods, `实际 ${r1.rows.length}`);
  const w = await write(to, "vg_vendor_scores", [{ period: "2099-01", vendor_code: vendorA, city: "CDMX", level: "S", total_score: 100, indicators: [] }]);
  check("写入 → 拒绝", !w);
  const r2 = await q(to, "vg_rules_internal?select=id");
  check("rules_internal → 0 行（ops 也不可见定线思路）", r2.rows.length === 0);
}

/* ---------- Admin：全量 + 可写 ---------- */
console.log("\n[admin]");
const tad = await signIn("test-admin@alianza-demo.example.com");
{
  const r1 = await q(tad, "vg_vendor_scores?select=vendor_code");
  check(`scores 全量 ${totalAllPeriods} 行（各期之和）`, r1.rows.length === totalAllPeriods, `实际 ${r1.rows.length}`);
  const r2 = await q(tad, "vg_rules_internal?select=id");
  check("rules_internal 可读", r2.rows.length === 1, `实际 ${r2.rows.length}`);
}

/* ---------- 匿名全表扫描（最重要：查 RLS 有没有漏开的关键） ---------- */
console.log("\n[匿名 · 仅 anon key 直接请求全部 10 张表]");
const ALL_TABLES = [
  "vg_user_roles", "vg_vendor_profile", "vg_vendor_scores", "vg_flex_adjustments",
  "vg_score_distribution", "vg_level_counts", "vg_periods",
  "vg_rules_public", "vg_rules_internal", "vg_rules_history",
];
for (const table of ALL_TABLES) {
  const res = await fetch(`${secrets.url}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: secrets.anon_key },
  });
  const rows = res.ok ? await res.json() : [];
  check(`${table} 匿名 → 0 行或拒绝`, !res.ok || rows.length === 0, `实际返回 ${rows.length} 行！RLS 漏了`);
  const w = await fetch(`${secrets.url}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: secrets.anon_key, "Content-Type": "application/json" },
    body: JSON.stringify([{}]),
  });
  check(`${table} 匿名写入 → 拒绝`, !w.ok);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} RLS 越权测试：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
