// RM 标杆视图（需求文档 3.1）。仅 RM 及以上角色渲染——本文件由 app.js 按角色分开挂载，
// Vendor 视角永远不会走到这里（不做通用组件传参控制可见性，那是最容易漏的写法）。
// 三层结构（S 样本薄时往下补）：
//   1. S 级 Vendor 明细（有几家显示几家，含名称——跨 RM 可见是有意的）
//   2. 各指标满分门槛 + S 级中位数（主力层，不依赖样本量）
//   3. 本城 A 级头部（够得着的下一站）——非本人名下且非 S 的一律匿名，只给指标不给身份

import { t, fmtNumber, fmtPoints, tUnit } from "../i18n.js";
import { activeIndicators, isCompositeInput, tierThreshold, tierMatches } from "../engine/rules.js";
import { badgeSmall } from "../components/badge.js";

const fmt1 = (n) => fmtNumber(n, { maximumFractionDigits: 1 });

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 满分门槛：{ label, threshold, meetsFn } —— 按 direction 通用推导，无业务字面值 */
function topTier(rule) {
  if (isCompositeInput(rule)) {
    // 预计算复合分：满分 = composite.no_debt_score（无欠款即满分）
    const v = rule.composite?.no_debt_score;
    return { label: fmtNumber(v), threshold: v, meets: (x) => x >= v, needDelta: (x) => v - x };
  }
  if (rule.direction === "higher_better") {
    const top = [...rule.tiers].sort((a, b) => tierThreshold(b) - tierThreshold(a))[0];
    const v = tierThreshold(top);
    return {
      label: t("gt" in top ? "tier.gt" : "tier.gte", { v: fmtNumber(v) }),
      threshold: v,
      meets: (x) => tierMatches(top, x),
      needDelta: (x) => v - x,
    };
  }
  const best = rule.tiers[0];
  const k = "lt" in best ? "lt" : "lte";
  const v = best[k];
  const label = k === "lte" && v === 0 ? t("tier.zero") : t(`tier.${k}`, { v: fmtNumber(v) });
  return {
    label,
    threshold: v,
    meets: (x) => (k === "lt" ? x < v : x <= v),
    needDelta: (x) => x - v,
  };
}

const valuesOf = (v) => Object.fromEntries(v.indicators.map((i) => [i.key, i.value]));
const scoresOf = (v) => Object.fromEntries(v.indicators.map((i) => [i.key, i.score]));

/**
 * 表格里展示的数值：复合指标（还款信用）的原始值是对象（分项集合），不能格式化 →
 * 一律展示其得分。其他指标展示原始值。（2026-08-14：新口径把 credit 从标量改成对象后踩过 NaN）
 */
function displayValue(rule, vendor) {
  const ind = vendor.indicators.find((i) => i.key === rule.key);
  if (!ind) return null;
  return isCompositeInput(rule) ? ind.score : ind.value;
}

function compareTable(rules, vendor, sVendors) {
  const values = valuesOf(vendor);
  const scores = scoresOf(vendor);
  const rows = activeIndicators(rules).map((rule) => {
    const tier = topTier(rule);
    const mine = displayValue(rule, vendor);
    const sMedian = median(sVendors.map((s) => displayValue(rule, s)).filter((x) => typeof x === "number"));
    const gap = tier.meets(mine)
      ? `<span class="muted">${t("bench.gap_ok")}</span>`
      : `<span class="fw" style="color:var(--action)">${t("bench.gap_need", {
          delta: fmt1(Math.abs(tier.needDelta(mine))), unit: tUnit(rule) })}</span>`;
    return `
    <tr>
      <td class="fw">${t(`indicator.${rule.key}`)} <span class="faint small">${tUnit(rule)}</span></td>
      <td class="n num">${fmt1(mine)}</td>
      <td class="n num">${fmtNumber(scores[rule.key])}</td>
      <td class="n num">${tier.label}</td>
      <td class="n num">${sMedian === null ? t("common.na") : fmt1(sMedian)}</td>
      <td class="n">${gap}</td>
    </tr>`;
  }).join("");
  return `
  <div class="card">
    <p class="faint small" style="margin-bottom:14px">${t("bench.compare_note", { name: vendor._displayName })}</p>
    <div class="table-scroll"><table>
      <thead><tr>
        <th>${t("bench.h.indicator")}</th><th class="n">${t("bench.h.mine")}</th><th class="n">${t("bench.h.score")}</th>
        <th class="n">${t("bench.h.top_tier")}</th><th class="n">${t("bench.h.s_median")}</th><th class="n">${t("bench.h.gap")}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="faint small" style="margin-top:12px">${t("bench.median_note")}</p>
  </div>`;
}

function vendorMetricsRow(rules, v) {
  return activeIndicators(rules).map((rule) => {
    const val = displayValue(rule, v);
    return `<td class="n num">${val === null || val === undefined ? t("common.na") : fmt1(val)}</td>`;
  }).join("");
}

function metricsHead(rules) {
  return activeIndicators(rules).map((rule) =>
    `<th class="n">${t(`indicator.${rule.key}`)}</th>`).join("");
}

function sDetailSection(rules, sVendors, profilesByCode) {
  if (!sVendors.length) {
    return `<section class="section"><div class="card muted">${t("bench.s_empty")}</div></section>`;
  }
  const rows = sVendors.map((v) => `
    <tr>
      <td>${badgeSmall("S", 20)} <span class="fw">${profilesByCode[v.vendor_code]?.display_name ?? v.vendor_code}</span>
          <span class="faint small">${v.city}</span></td>
      <td class="n num fw">${fmtPoints(v.total_score)}</td>
      ${vendorMetricsRow(rules, v)}
    </tr>`).join("");
  return `
  <section class="section">
    <h2>${t("bench.s_detail", { n: fmtNumber(sVendors.length) })}</h2>
    <div class="card"><div class="table-scroll"><table>
      <thead><tr><th>${t("admin.h.vendor")}</th><th class="n">POINTS</th>${metricsHead(rules)}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>
  </section>`;
}

function aTopSection(rules, vendorsData, vendor, rmName, profilesByCode, limit = 3) {
  const aTop = vendorsData.vendors
    .filter((v) => v.city === vendor.city && v.level === "A")
    .sort((a, b) => b.total_score - a.total_score)
    .slice(0, limit);
  const rows = aTop.map((v, i) => {
    const p = profilesByCode[v.vendor_code];
    const own = rmName && p?.rm === rmName;
    const label = own
      ? `<span class="fw">${p?.display_name ?? v.vendor_code}</span> <span class="badge-corner">${t("bench.a_own_tag")}</span>`
      : `<span class="muted">${t("bench.a_anon", { n: fmtNumber(i + 1) })}</span>`;
    return `
    <tr>
      <td>${badgeSmall("A", 20)} ${label}</td>
      <td class="n num fw">${fmtPoints(v.total_score)}</td>
      ${vendorMetricsRow(rules, v)}
    </tr>`;
  }).join("");
  return `
  <section class="section">
    <h2>${t("bench.a_top")}</h2>
    <div class="card">
      ${aTop.length ? `<div class="table-scroll"><table>
        <thead><tr><th>${t("admin.h.vendor")}</th><th class="n">POINTS</th>${metricsHead(rules)}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : `<p class="muted">${t("bench.a_empty")}</p>`}
      <p class="faint small" style="margin-top:12px">${t("bench.privacy")}</p>
    </div>
  </section>`;
}

export function renderBenchmark({ rules, vendorsData, vendor, profilesByCode, rmName }) {
  const sVendors = vendorsData.vendors.filter((v) => v.level === "S");
  vendor._displayName = profilesByCode[vendor.vendor_code]?.display_name ?? vendor.vendor_code;
  return `
  <section class="section">
    <h2 class="page-title">${t("bench.title")}</h2>
    <p class="faint small" style="margin:10px 0 18px">${t("bench.intro")}</p>
    ${compareTable(rules, vendor, sVendors)}
  </section>
  ${sDetailSection(rules, sVendors, profilesByCode)}
  ${aTopSection(rules, vendorsData, vendor, rmName, profilesByCode)}`;
}
