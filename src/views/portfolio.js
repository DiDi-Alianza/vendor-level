// RM 全盘视图（2026-08-14 用户要求）：RM 登录先看名下所有商的总览与共性短板，
// 再点具体商进详情。内部运营/主管理员看全部商户。
// 数据隔离：本页只渲染「调用方传进来的 roster」——RM 视角的 roster 由 app.js 过滤为名下商户，
// 本文件不自行扩大范围，也不引用 S 级标杆（那是 benchmark 页的事）。

import { t, fmtNumber, fmtPoints } from "../i18n.js";
import { computeScores, activeIndicators, applyFlexAdjustment } from "../engine/rules.js";
import { protectionStatus } from "../engine/protection.js";
import { badgeSmall } from "../components/badge.js";

const LEVELS = ["S", "A", "B", "C"];

/** 每家的派生信息：调整后总分、最弱项、风险旗 */
function enrich(rules, vendor, profile, period) {
  const values = Object.fromEntries(vendor.indicators.map((i) => [i.key, i.value]));
  const { scores, contributions } = computeScores(rules, values);
  const adjusted = applyFlexAdjustment(rules, vendor.total_score, vendor.flex_adjustments ?? []).adjusted;

  // 最弱项 = 丢分最多的一项（满分贡献 − 实际贡献）
  let weakest = null;
  for (const rule of activeIndicators(rules)) {
    const loss = (100 - scores[rule.key]) * rule.weight;
    if (!weakest || loss > weakest.loss) weakest = { key: rule.key, loss, score: scores[rule.key] };
  }

  const prot = period.type === "weekly"
    ? { status: "n/a" }
    : protectionStatus(profile?.first_order_date ?? null, period.month, rules.new_vendor_protection);

  return { values, scores, contributions, adjusted, weakest, prot };
}

export function renderPortfolio({ rules, roster, profilesByCode, period, scopeLabel, isAll }) {
  if (!roster.length) {
    return `<section class="section"><h2 class="page-title">${t("portfolio.title")}</h2>
      <div class="empty-state">${t("portfolio.empty")}</div></section>`;
  }

  const rows = roster.map((v) => ({
    v,
    p: profilesByCode[v.vendor_code],
    ...enrich(rules, v, profilesByCode[v.vendor_code], period),
  })).sort((a, b) => b.adjusted - a.adjusted);

  // ---- KPI ----
  const n = rows.length;
  const avg = rows.reduce((s, r) => s + r.adjusted, 0) / n;
  const counts = Object.fromEntries(LEVELS.map((l) => [l, rows.filter((r) => r.v.level === l).length]));
  const sa = ((counts.S + counts.A) / n) * 100;
  const riskSet = new Set();
  for (const r of rows) {
    if (r.v.level === "C" || r.v.redline || r.v.double_zero) riskSet.add(r.v.vendor_code);
  }

  const cityDetail = [...new Set(rows.map((r) => r.v.city))].map((city) => {
    const sub = rows.filter((r) => r.v.city === city);
    const s = sub.filter((r) => r.v.level === "S").length + sub.filter((r) => r.v.level === "A").length;
    return t("portfolio.city_split_item", {
      city, n: fmtNumber(sub.length), sa: ((s / sub.length) * 100).toFixed(0),
    });
  }).join(t("common.pipe"));

  const kpi = `
  <div class="card" style="display:flex;gap:56px;flex-wrap:wrap;align-items:baseline">
    <span><span class="faint small">${t("portfolio.kpi_avg")}</span><br>
      <span class="num fw" style="font-size:30px">${fmtPoints(avg)}</span></span>
    <span><span class="faint small">${t("portfolio.kpi_sa")}</span><br>
      <span class="num fw" style="font-size:30px">${fmtNumber(sa, { maximumFractionDigits: 0 })}%</span></span>
    <span><span class="faint small">${t("portfolio.kpi_risk")}</span><br>
      <span class="num fw" style="font-size:30px${riskSet.size ? ";color:var(--alert)" : ""}">${riskSet.size}</span>
      <span class="faint small"> / ${n}</span></span>
    <span class="faint small" style="max-width:280px">${t("portfolio.kpi_risk_note")}<br>${
      t("portfolio.city_split", { detail: cityDetail })}</span>
  </div>`;

  // ---- 等级分布（横向堆叠条，无家数以外的身份信息） ----
  const distBar = `
  <div class="card">
    <h3 class="fw" style="margin-bottom:12px">${t("portfolio.dist_title")}</h3>
    <div class="pf-dist">
      ${LEVELS.filter((l) => counts[l]).map((l) => `
        <div class="pf-dist-seg lv-${l}" style="flex:${counts[l]}" title="${l} ${counts[l]}">
          <span>${l} ${counts[l]}</span>
        </div>`).join("")}
    </div>
  </div>`;

  // ---- 共性短板：名下哪些指标丢分最多 ----
  const weakStats = activeIndicators(rules).map((rule) => {
    const scores = rows.map((r) => r.scores[rule.key]);
    const zeros = scores.filter((s) => s === 0).length;
    const avgScore = scores.reduce((a, b) => a + b, 0) / n;
    const loss = scores.reduce((a, s) => a + (100 - s) * rule.weight, 0);
    return { rule, zeros, avgScore, loss, avgLoss: loss / n };
  }).sort((a, b) => b.loss - a.loss);

  const weakest = `
  <div class="card">
    <h3 class="fw" style="margin-bottom:12px">${t("portfolio.weakest_title")}</h3>
    <ul style="padding-left:20px" class="muted">
      ${weakStats.slice(0, 3).map((w) => `<li style="margin-bottom:6px">${t("portfolio.weakest_row", {
        indicator: t(`indicator.${w.rule.key}`),
        n: fmtNumber(w.zeros),
        avg: fmtNumber(w.avgScore, { maximumFractionDigits: 0 }),
        loss: fmtPoints(w.avgLoss),
      })}</li>`).join("")}
    </ul>
  </div>`;

  // ---- 逐家明细 ----
  const listRows = rows.map((r) => {
    const flags = [
      r.v.redline ? `<span class="chip alert">${t("portfolio.risk_redline")}</span>` : "",
      r.v.double_zero ? `<span class="chip">${t("portfolio.risk_dz")}</span>` : "",
      r.prot.status === "exempt" ? `<span class="chip">${t("portfolio.risk_protected")}</span>` : "",
    ].join("");
    const chg = r.v.level_change === "↑" ? `<span class="pf-up">↑</span>`
      : r.v.level_change === "↓" ? `<span class="pf-down">↓</span>` : `<span class="faint">—</span>`;
    return `
    <tr class="pf-row" data-vendor="${r.v.vendor_code}" tabindex="0" role="button">
      <td><span class="fw">${r.p?.display_name ?? r.v.vendor_code}</span>
          <div class="faint small num">${r.v.city}${isAll ? ` · ${r.p?.rm ?? t("common.rm_unassigned")}` : ""}</div></td>
      <td>${badgeSmall(r.v.level, 20)}</td>
      <td class="n num fw">${fmtPoints(r.adjusted)}</td>
      <td class="n">${chg}</td>
      <td class="small">${t(`indicator.${r.weakest.key}`)} <span class="faint num">${fmtNumber(r.weakest.score)}</span></td>
      <td>${flags}</td>
      <td class="n"><button type="button" class="scope-btn pf-view" data-vendor="${r.v.vendor_code}">${t("portfolio.view")}</button></td>
    </tr>`;
  }).join("");

  const list = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;gap:16px;flex-wrap:wrap">
      <h3 class="fw">${t("portfolio.list_title")}</h3>
      <span class="faint small">${t("portfolio.flags_legend")}</span>
      <span class="faint small">${t("portfolio.sort_hint")}</span>
    </div>
    <div class="table-scroll"><table>
      <thead><tr>
        <th>${t("portfolio.h.vendor")}</th><th>${t("portfolio.h.level")}</th>
        <th class="n">${t("portfolio.h.points")}</th><th class="n">${t("portfolio.h.change")}</th>
        <th>${t("portfolio.h.weakest")}</th><th>${t("portfolio.h.flags")}</th><th></th>
      </tr></thead>
      <tbody>${listRows}</tbody>
    </table></div>
  </div>`;

  return `
  <section class="section">
    <h2 class="page-title">${isAll ? t("portfolio.title_all") : t("portfolio.title")}</h2>
    <p class="faint small" style="margin:10px 0 18px">${t("portfolio.subtitle", {
      scope: scopeLabel, n: fmtNumber(n), period: period.label })}</p>
    ${kpi}
    ${distBar}
    ${weakest}
  </section>
  <section class="section">${list}</section>`;
}

/** 点行/点按钮 → 切到该商详情（由 app.js 提供跳转回调） */
export function bindPortfolio(onPick) {
  const go = (code) => { if (code) onPick(code); };
  document.querySelectorAll(".pf-view").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); go(b.dataset.vendor); }));
  document.querySelectorAll(".pf-row").forEach((tr) => {
    tr.addEventListener("click", () => go(tr.dataset.vendor));
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(tr.dataset.vendor); }
    });
  });
}
