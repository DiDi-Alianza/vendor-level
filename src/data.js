// 数据接入层：唯一的数据入口，本地 JSON（阶段一演示）与 Supabase（阶段二上线）在此切换。
// 页面代码只调这里的函数，不感知数据来自哪里——切换数据源时页面零改动。
//
// 安全边界（技术决策记录）：前端过滤只是显示效果；真正的隔离在 Supabase RLS（数据库行级安全），
// 与静态托管平台（GitHub Pages / Cloudflare / Vercel）无关。
//
// 两种数据源产出完全相同的形状：
//   { rules, profileData:{profiles}, periodsIndex:{default,monthly,weekly}, identity? }
//   { vendors:[…], meta:{…}, stats:{scopes,perVendor} }
// stats 在 local 源由 engine/ranking.js 现算，在 supabase 源来自库内预计算列 + 聚合表——
// 同一算法（导入时也用同一模块写入），保证口径不漂移。

import { buildRankingStats } from "./engine/ranking.js";
import { select, isSignedIn, currentUserId } from "./supabase.js";

// "local" = 演示（读 data/*.json，无需登录）｜"supabase" = 上线（登录 + RLS）
export const SOURCE = "supabase";

export const needsAuth = () => SOURCE === "supabase";

/* ---------------- local 源 ---------------- */

async function loadStaticLocal() {
  const [rules, profileData, periodsIndex] = await Promise.all([
    fetch("data/rules.json").then((x) => x.json()),
    fetch("data/vendor_profile.json").then((x) => x.json()),
    fetch("data/periods.json").then((x) => x.json()),
  ]);
  return { rules, profileData, periodsIndex, identity: null };
}

async function loadPeriodLocal(entry, rules) {
  const data = await fetch(`data/${entry.file}`).then((x) => x.json());
  data.stats = buildRankingStats(rules, data.vendors);
  return data;
}

/* ---------------- supabase 源 ---------------- */

async function loadStaticSupabase() {
  // 身份：按自己的 uid 精确取。
  // 不能只靠 RLS 过滤——主管理员的策略允许读全表（要管账号），不带 uid 条件时会拿到别人的角色行。
  const uid = await currentUserId();
  if (!uid) {
    const err = new Error("no session user id");
    err.code = "auth.required";
    throw err;
  }
  const roles = await select("vg_user_roles",
    `select=role,vendor_code,rm_name&user_id=eq.${encodeURIComponent(uid)}`);
  if (!roles.length) {
    const err = new Error("account has no role binding");
    err.code = "auth.no_role"; // 账号存在但未绑角色 → 明确报错，不静默降级成空页面
    throw err;
  }
  const identity = {
    role: roles[0].role,
    vendorCode: roles[0].vendor_code ?? null,
    rmName: roles[0].rm_name ?? null,
  };

  const [rulesRows, profiles, periodRows] = await Promise.all([
    select("vg_rules_public", "select=body&order=created_at.desc&limit=1"),
    select("vg_vendor_profile", "select=vendor_code,display_name,city,rm_name,first_order_date,active_status"),
    select("vg_periods", "select=*"),
  ]);
  if (!rulesRows.length) {
    const err = new Error("no published rules");
    err.code = "data.rules_missing";
    throw err;
  }

  const monthly = [], weekly = [];
  for (const p of periodRows) {
    const e = {
      id: p.period, type: p.type, days: p.days,
      vendor_count: p.vendor_count, disclaimer: p.disclaimer,
      weeks: p.weeks ?? null, week_label: p.week_label ?? null,
      range: p.date_range ?? null, month: p.month ?? p.period,
    };
    (p.type === "weekly" ? weekly : monthly).push(e);
  }
  monthly.sort((a, b) => b.id.localeCompare(a.id));
  weekly.sort((a, b) => b.id.localeCompare(a.id));

  return {
    rules: rulesRows[0].body,
    profileData: {
      profiles: profiles.map((p) => ({
        vendor_code: p.vendor_code, display_name: p.display_name, city: p.city,
        rm: p.rm_name, first_order_date: p.first_order_date, active_status: p.active_status,
      })),
    },
    periodsIndex: { default: { type: monthly[0] ? "monthly" : "weekly", id: (monthly[0] ?? weekly[0])?.id ?? null }, monthly, weekly },
    identity,
  };
}

async function loadPeriodSupabase(entry) {
  const period = encodeURIComponent(entry.id);
  const [rows, dist, lvl] = await Promise.all([
    select("vg_vendor_scores", `select=*&period=eq.${period}`),
    select("vg_score_distribution", `select=scope,bin_start,cnt&period=eq.${period}`),
    select("vg_level_counts", `select=scope,level,cnt&period=eq.${period}`),
  ]);

  // 名次/百分位来自库内预计算列（Vendor 只有自己 1 行，绝不能靠遍历算）
  const perVendor = {};
  for (const r of rows) {
    perVendor[r.vendor_code] = {
      rank_all: r.rank_all, pct_all: r.pct_all,
      rank_city: r.rank_city, pct_city: r.pct_city,
      rank_level: r.rank_level,   // 等级内排名（迁移 003）：Vendor 只有自己 1 行，必须用预计算列
    };
  }
  // 分布/等级家数来自聚合表（无身份信息，所有登录角色可读）
  const scopes = {};
  for (const d of dist) {
    (scopes[d.scope] ??= { total: 0, bins: [], levelCounts: {} }).bins.push({ bin_start: d.bin_start, cnt: d.cnt });
  }
  for (const l of lvl) {
    const s = (scopes[l.scope] ??= { total: 0, bins: [], levelCounts: {} });
    s.levelCounts[l.level] = l.cnt;
  }
  for (const s of Object.values(scopes)) {
    s.bins.sort((a, b) => a.bin_start - b.bin_start);
    s.total = Object.values(s.levelCounts).reduce((a, b) => a + b, 0);
  }

  return {
    meta: {
      period: entry.id,
      period_detail: { label: entry.id, weeks: entry.weeks },
      period_type: entry.type,
      vendor_count: entry.vendor_count,
    },
    vendors: rows.map((r) => ({
      vendor_code: r.vendor_code, city: r.city, level: r.level,
      level_official_v1: r.level_official_v1, level_change: r.level_change,
      total_score: Number(r.total_score), redline: r.redline,
      redline_week_hit: r.redline_week_hit,
      indicators: r.indicators,
      flex_adjustments: [], // 由 loadFlex 单独补（表分离便于审计）
    })),
    stats: { scopes, perVendor },
  };
}

/* ---------------- 统一出口 ---------------- */

export async function loadStatic() {
  return SOURCE === "supabase" ? loadStaticSupabase() : loadStaticLocal();
}

export async function loadPeriodData(entry, rules) {
  return SOURCE === "supabase" ? loadPeriodSupabase(entry) : loadPeriodLocal(entry, rules);
}

/** 规则热重载（管理后台保存/回滚后调用） */
export async function reloadRules() {
  if (SOURCE === "local") {
    return fetch(`data/rules.json?t=${Date.now()}`).then((x) => x.json());
  }
  const rows = await select("vg_rules_public", "select=body&order=created_at.desc&limit=1");
  return rows[0]?.body;
}

/** 把 periods 条目归一化为视图用的 period 对象（月度/周度统一形状） */
export function normalizePeriod(entry, t) {
  if (!entry) return null;
  if (entry.type === "weekly") {
    return {
      id: entry.id,
      type: "weekly",
      label: entry.range
        ? t("period.weekly_label", { wk: entry.week_label, range: entry.range })
        : entry.week_label ?? entry.id,
      days: entry.days,
      month: entry.month,       // 周度所属自然月（按月的逻辑如保护期需要）
      disclaimer: true,         // 周度=试算，页面必须标注非正式评级
      vendorCount: entry.vendor_count,
    };
  }
  const month = Number((entry.id.split("-")[1] ?? "").replace(/^0/, ""));
  return {
    id: entry.id,
    type: "monthly",
    label: t("period.month_label", { m: month }),
    days: entry.days,
    month: entry.id,
    weeks: entry.weeks,
    disclaimer: false,
    vendorCount: entry.vendor_count,
  };
}

export { isSignedIn };
