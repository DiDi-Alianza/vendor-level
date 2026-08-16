// 四角色适配器验收（bun scripts/test_roles.js）——SOURCE=supabase 切换后必跑。
//
// 与 test_rls.js 的分工：
//   test_rls.js  验「数据库层拦没拦住」——匿名与越权请求必须返回 0 行；
//   本脚本       验「页面拿到的数据对不对」——按四个角色登录，跑一遍 src/data.js 实际发出的那组查询，
//                断言每个角色看到的内容与需求文档 3.1 的可见范围一致，且新加的预计算列都在。
//
// 为什么单独写：RLS 通过不等于页面正确。少一列（如迁移 003 前的 rank_level）时 RLS 依旧全过，
// 但 Vendor 的「等级内第几名」会静默消失——只有把 data.js 的查询原样跑一遍才发现得了。

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const secrets = JSON.parse(readFileSync(join(SITE, "scripts", ".supabase_secrets.json"), "utf-8"));
const profileData = JSON.parse(readFileSync(join(SITE, "data", "vendor_profile.json"), "utf-8"));
const index = JSON.parse(readFileSync(join(SITE, "data", "periods.json"), "utf-8"));
const main = index.monthly[0];
const localMain = JSON.parse(readFileSync(join(SITE, "data", main.file), "utf-8"));

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
  const body = await res.json();
  return { token: body.access_token, uid: body.user?.id };
}

async function q(token, pathAndQuery) {
  const res = await fetch(`${secrets.url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: secrets.anon_key, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { error: `${res.status} ${await res.text()}` };
  return res.json();
}

/** 原样复刻 src/data.js 的 loadStaticSupabase + loadPeriodSupabase 会发出的查询 */
async function loadAs({ token, uid }, periodId) {
  const [roles, rulesRows, profiles, periodRows] = await Promise.all([
    // 与 src/data.js 一致：按自己的 uid 取身份，不依赖 RLS 恰好只返回一行
    q(token, `vg_user_roles?select=role,vendor_code,rm_name&user_id=eq.${uid}`),
    q(token, "vg_rules_public?select=body&order=created_at.desc&limit=1"),
    q(token, "vg_vendor_profile?select=vendor_code,display_name,city,rm_name,first_order_date,active_status"),
    q(token, "vg_periods?select=*"),
  ]);
  const p = encodeURIComponent(periodId);
  const [scores, dist, lvl] = await Promise.all([
    q(token, `vg_vendor_scores?select=*&period=eq.${p}`),
    q(token, `vg_score_distribution?select=scope,bin_start,cnt&period=eq.${p}`),
    q(token, `vg_level_counts?select=scope,level,cnt&period=eq.${p}`),
  ]);
  return { roles, rulesRows, profiles, periodRows, scores, dist, lvl };
}

const ACCOUNTS = {
  vendor: "test-vendor-a@alianza-demo.example.com",
  rm: "test-rm@alianza-demo.example.com",
  ops: "test-ops@alianza-demo.example.com",
  admin: "test-admin@alianza-demo.example.com",
};

console.log(`\n四角色适配器验收 · 期次 ${main.id}（本地基准 ${localMain.vendors.length} 家）\n`);

// ---------- Vendor ----------
{
  const sess = await signIn(ACCOUNTS.vendor);
  const { token } = sess;
  const d = await loadAs(sess, main.id);
  console.log("[vendor]");
  check("身份行恰好 1 条且 role=vendor", d.roles.length === 1 && d.roles[0].role === "vendor",
    JSON.stringify(d.roles));
  const me = d.roles[0].vendor_code;
  check("规则公示可读", d.rulesRows.length === 1 && !!d.rulesRows[0].body);
  check("评分行只有自己 1 行", d.scores.length === 1 && d.scores[0].vendor_code === me,
    `实际 ${d.scores.length} 行`);
  // 新加的预计算列必须都在——缺列时 RLS 全过但页面静默少东西（迁移 003 的教训）
  const r = d.scores[0] ?? {};
  check("rank_level 有值（等级内排名）", Number.isInteger(r.rank_level), `实际 ${r.rank_level}`);
  check("rank_city 有值（本城排名）", Number.isInteger(r.rank_city), `实际 ${r.rank_city}`);
  check("indicators 是数组且 6 项", Array.isArray(r.indicators) && r.indicators.length === 6,
    `实际 ${r.indicators?.length}`);
  const localMe = localMain.vendors.find((v) => v.vendor_code === me);
  check("总分与本地重算一致", Number(r.total_score) === localMe.total_score,
    `库 ${r.total_score} vs 本地 ${localMe.total_score}`);
  check("等级与本地重算一致", r.level === localMe.level, `库 ${r.level} vs 本地 ${localMe.level}`);
  // 分布/等级家数是聚合表，无身份信息 → Vendor 也该读得到（画分布图用）
  check("分布聚合可读（画分布图）", Array.isArray(d.dist) && d.dist.length > 0, JSON.stringify(d.dist).slice(0, 80));
  check("等级家数聚合可读", Array.isArray(d.lvl) && d.lvl.length > 0);
  // 内部规则（备选线 / SA 目标）只有 admin 能读
  const internal = await q(token, "vg_rules_internal?select=body");
  check("内部规则不可读（备选线/SA 目标）", internal.error || internal.length === 0,
    JSON.stringify(internal).slice(0, 80));
}

// ---------- RM ----------
{
  const sess = await signIn(ACCOUNTS.rm);
  const { token } = sess;
  const d = await loadAs(sess, main.id);
  console.log("\n[rm]");
  const rmName = d.roles[0]?.rm_name;
  check("身份行 role=rm 且带 rm_name", d.roles.length === 1 && d.roles[0].role === "rm" && !!rmName,
    JSON.stringify(d.roles));
  const roster = new Set(profileData.profiles.filter((p) => p.rm === rmName).map((p) => p.vendor_code));
  const expect = localMain.vendors.filter((v) => roster.has(v.vendor_code) || v.level === "S");
  check(`可见 = 名下 ∪ S 级（应 ${expect.length} 家）`, d.scores.length === expect.length,
    `实际 ${d.scores.length}`);
  const outside = d.scores.filter((s) => !roster.has(s.vendor_code) && s.level !== "S");
  check("没有名下之外的非 S 级商", outside.length === 0,
    outside.slice(0, 3).map((s) => s.vendor_code).join(","));
  check("名下每家 rank_level 都有值",
    d.scores.filter((s) => roster.has(s.vendor_code)).every((s) => Number.isInteger(s.rank_level)));
  const internal = await q(token, "vg_rules_internal?select=body");
  check("内部规则不可读", internal.error || internal.length === 0);
}

// ---------- ops / admin ----------
for (const role of ["ops", "admin"]) {
  const sess = await signIn(ACCOUNTS[role]);
  const { token } = sess;
  const d = await loadAs(sess, main.id);
  console.log(`\n[${role}]`);
  check(`按 uid 取到的身份行恰好 1 条且 role=${role}`,
    d.roles.length === 1 && d.roles[0].role === role, JSON.stringify(d.roles));
  if (role === "admin") {
    // 主管理员按设计可读全表（要管账号）；正因如此，取身份必须带 uid 条件，
    // 否则 roles[0] 可能是别人的行 —— 这正是 2026-08-16 修掉的 BUG-007
    const all = await q(sess.token, "vg_user_roles?select=role");
    check("主管理员可读全部角色绑定（账号管理需要）", Array.isArray(all) && all.length > 1,
      `实际 ${all.length} 行`);
  }
  check(`可见全部 ${localMain.vendors.length} 家`, d.scores.length === localMain.vendors.length,
    `实际 ${d.scores.length}`);
  check("商档案可读（显示名/RM/首单日期）", d.profiles.length === profileData.profiles.length,
    `实际 ${d.profiles.length} / 本地 ${profileData.profiles.length}`);
  check("期次索引可读", Array.isArray(d.periodRows) && d.periodRows.length > 0);
  const internal = await q(token, "vg_rules_internal?select=body");
  if (role === "admin") {
    check("内部规则可读（仅主管理员）", Array.isArray(internal) && internal.length === 1,
      JSON.stringify(internal).slice(0, 80));
  } else {
    check("内部规则不可读", internal.error || internal.length === 0,
      JSON.stringify(internal).slice(0, 80));
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 四角色适配器验收：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
