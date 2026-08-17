// 排名与分布的唯一算法实现。三处共用，防止"库里预计算的"和"页面算的"漂移：
//   1. scripts/supabase_import.js —— 导入时写进 vg_vendor_scores 的 rank_*/pct_* 列与聚合表
//   2. src/data.js（local 源）—— 加载后在内存里补齐同样的字段
//   3. src/views/ranking.js —— 只消费统一形状，不自己算
// 关键约束（阶段二 RLS）：Vendor 端只能拿到自己 1 行，页面绝不能靠"遍历全网"算名次——
// 否则会显示"第 1/1 名"且看起来完全正常。名次一律来自预计算值，分布一律来自聚合表。

import { applyFlexAdjustment } from "./rules.js";

export const BIN_SIZE = 10;
export const LEVELS = ["S", "A", "B", "C"];

/** 参与排名的分数 = 灵活分调整后的综合分 */
export function adjustedScore(rules, v) {
  return applyFlexAdjustment(rules, v.total_score, v.flex_adjustments ?? []).adjusted;
}

/** competition ranking：并列同名次 */
export function rankIn(rules, pool, vendor) {
  const mine = adjustedScore(rules, vendor);
  const scores = pool.map((v) => adjustedScore(rules, v)).sort((a, b) => b - a);
  return {
    rank: scores.findIndex((s) => s <= mine) + 1,
    total: pool.length,
    pct: Math.round((pool.filter((v) => adjustedScore(rules, v) < mine).length / pool.length) * 100),
  };
}

/** 分数分箱（无身份信息，可安全下发给任何角色） */
export function binsIn(rules, pool) {
  const bins = {};
  for (const v of pool) {
        const b = Math.min(100 - BIN_SIZE, Math.floor(adjustedScore(rules, v) / BIN_SIZE) * BIN_SIZE);
    bins[b] = (bins[b] ?? 0) + 1;
  }
  return Object.entries(bins)
    .map(([bin_start, cnt]) => ({ bin_start: Number(bin_start), cnt }))
    .sort((a, b) => a.bin_start - b.bin_start);
}

export function levelCountsIn(pool) {
  return Object.fromEntries(LEVELS.map((l) => [l, pool.filter((v) => v.level === l).length]));
}

/**
 * 一期数据的完整排名视图。
 * @returns {{
 *   scopes: { [scope: string]: { total, bins, levelCounts } },   // scope: 'all' | 城市名
 *   perVendor: { [vendorCode]: { rank_all, pct_all, rank_city, pct_city } }
 * }}
 */
export function buildRankingStats(rules, vendors) {
  const cities = [...new Set(vendors.map((v) => v.city))];
  const pools = { all: vendors, ...Object.fromEntries(cities.map((c) => [c, vendors.filter((v) => v.city === c)])) };

  const scopes = {};
  for (const [scope, pool] of Object.entries(pools)) {
    scopes[scope] = { total: pool.length, bins: binsIn(rules, pool), levelCounts: levelCountsIn(pool) };
  }

  const perVendor = {};
  for (const v of vendors) {
    const all = rankIn(rules, pools.all, v);
    const city = rankIn(rules, pools[v.city], v);
    // 等级内排名：同等级全网比较（2026-08-14 用户要求：只给「等级内第几」与「本城第几」，不给总家数）
    const level = rankIn(rules, vendors.filter((x) => x.level === v.level), v);
    perVendor[v.vendor_code] = {
      rank_all: all.rank, pct_all: all.pct,
      rank_city: city.rank, pct_city: city.pct,
      rank_level: level.rank,
    };
  }
  return { scopes, perVendor };
}

/** 页面消费的统一形状：某商 + 某范围 → 名次/百分位/分布/等级家数 */
export function statsFor(stats, vendor, scope) {
  const key = scope === "city" ? vendor.city : "all";
  const s = stats.scopes[key];
  const pv = stats.perVendor[vendor.vendor_code] ?? {};
  return {
    rank: scope === "city" ? pv.rank_city : pv.rank_all,
    pct: scope === "city" ? pv.pct_city : pv.pct_all,
    total: s?.total ?? 0,
    bins: s?.bins ?? [],
    levelCounts: s?.levelCounts ?? {},
  };
}
