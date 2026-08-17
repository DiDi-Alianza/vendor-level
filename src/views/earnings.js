// 收益预估页（需求文档 6.5）。两个口径都展示并标注；50 万封顶走引擎 estimateIncentive；
// 红线冻结金额置灰；双 0 商不铺一串 0，直接导流建议页两条路径。
// 全月外推口径 = 日均 × 当月自然日天数（已用触顶商做过封顶前后的锚点校验），天数由 period.label 计算。

import { t, fmtNumber, fmtCurrency, fmtPoints, tUnit } from "../i18n.js";
import { computeScores, adviceBranch, estimateIncentive } from "../engine/rules.js";
import { badgeSmall } from "../components/badge.js";

const LEVEL_ORDER = ["C", "B", "A", "S"];

export function renderEarnings({ rules, vendor, period }) {
  const values = Object.fromEntries(vendor.indicators.map((i) => [i.key, i.value]));
  const { scores } = computeScores(rules, values);
  const branch = adviceBranch(rules, scores);
  const currency = rules.incentive.currency;
  const days = period.days; // 月度=当月自然日；周度=7
  const daily = values[rules.s_scale_gate.indicator];
  const monthly = daily * days;
  const est = estimateIncentive(rules, vendor.level, monthly, { redline: vendor.redline });
  const rate = rules.incentive.rates[vendor.level];

  const head = `
  <section class="section">
    <h2 class="page-title">${t("earnings.title")}</h2>
    <div class="card" style="display:flex;gap:28px;align-items:center;flex-wrap:wrap">
      <span class="badge-inline">${badgeSmall(vendor.level, 28)}
        <span class="fw" style="font-size:18px">${t(period.type === "weekly" ? "earnings.level_label_weekly" : "earnings.level_label")}</span></span>
      <span class="num muted">POINTS ${fmtPoints(vendor.total_score)}</span>
      ${vendor.redline ? `<span class="chip alert"><span class="dot"></span>${t("overview.redline_hit")}</span>` : ""}
    </div>
  </section>`;

  // 双 0 商：不铺零，导流两条路径
  if (branch?.key === "double_zero") {
    return `${head}
    <section class="section">
      <div class="card">
        <p class="muted">${t("earnings.dz_redirect")}</p>
        <p style="margin-top:14px"><a class="btn" href="#/advice">${t("earnings.dz_cta")}</a></p>
      </div>
      <p class="faint small" style="margin-top:12px">${t("earnings.disclaimer")}</p>
    </section>`;
  }

  const volume = `
  <section class="section">
    <h2>${t("earnings.volume_title")}</h2>
    <div class="card">
      <div style="display:flex;gap:48px;flex-wrap:wrap">
        <div>
          <div class="faint small">${t("earnings.volume_daily")}</div>
          <div class="num fw" style="font-size:28px">${fmtNumber(daily, { maximumFractionDigits: 0 })}
            <span class="faint" style="font-size:14px;font-weight:400">${tUnit(rules.indicators.find(i => i.key === rules.s_scale_gate.indicator))}</span></div>
        </div>
        <div>
          <div class="faint small">${t(period.type === "weekly" ? "earnings.volume_week" : "earnings.volume_month", { days: fmtNumber(days) })}</div>
          <div class="num fw" style="font-size:28px">${fmtNumber(Math.round(monthly))}</div>
        </div>
        ${period.type === "weekly" ? "" : `<div>
          <div class="faint small">${t("earnings.volume_mtd")}</div>
          <div class="muted small" style="margin-top:10px">${t("earnings.volume_mtd_pending")}</div>
        </div>`}
      </div>
      <p class="faint small" style="margin-top:16px">${t("earnings.proxy_note")}${
        period.type === "weekly" ? `<br>${t("earnings.weekly_note")}` : ` ${t("earnings.proxy_note_month")}`}</p>
    </div>
  </section>`;

  const amountStyle = est.frozen ? "color:var(--ink-3)" : "color:var(--ink)";
  const estBlock = rate > 0 ? `
    <div class="num fw" style="font-size:40px;${amountStyle}">${fmtCurrency(est.amount, currency)}</div>
    <div class="faint small num">${t("earnings.est_formula", {
      orders: fmtNumber(Math.round(monthly)),
      rate: fmtCurrency(rate, currency),
    })}</div>
    ${est.capped ? `<p class="muted small" style="margin-top:8px">${t("earnings.capped", {
      cap: fmtCurrency(rules.incentive.per_vendor_monthly_cap, currency),
      raw: fmtCurrency(Math.round(monthly * rate), currency),
    })}</p>` : ""}
    ${est.frozen ? `<p class="small fw" style="color:var(--alert);margin-top:10px">${t("earnings.frozen")}</p>` : ""}`
  : `<div class="muted">${t("earnings.none_bc")}</div>`;

  // 升一级对比（与提分模拟器联动：导流）
  const idx = LEVEL_ORDER.indexOf(vendor.level);
  let upgrade = "";
  if (idx < LEVEL_ORDER.length - 1) {
    const next = LEVEL_ORDER[idx + 1];
    const nextEst = estimateIncentive(rules, next, monthly);
    const delta = nextEst.amount - (est.frozen ? 0 : est.amount);
    upgrade = `
    <section class="section">
      <h2>${t("earnings.upgrade_title")}</h2>
      <div class="card">
        <p class="num">${badgeSmall(next, 20)} ${t("earnings.upgrade_row", {
          level: next, amount: fmtCurrency(nextEst.amount, currency) })}
          ${delta > 0 ? `<span class="fw">${t("common.paren_open")}${t("earnings.upgrade_delta", { delta: fmtCurrency(delta, currency) })}${t("common.paren_close")}</span>` : ""}</p>
        <p style="margin-top:12px"><a href="#/advice">${t("earnings.upgrade_hint")}</a></p>
      </div>
    </section>`;
  }

  return `${head}${volume}
  <section class="section">
    <h2>${t("earnings.est_title")}</h2>
    <div class="card">${estBlock}</div>
  </section>
  ${upgrade}
  <section class="section"><p class="faint small">${t("earnings.disclaimer")}</p></section>`;
}
