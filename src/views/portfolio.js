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

  // ---- 分城对比：两城并排，一眼看出差异（2026-08-16 用户要求） ----
  const cities = [...new Set(rows.map((r) => r.v.city))].sort();
  const statOf = (sub) => {
    const c = Object.fromEntries(LEVELS.map((l) => [l, sub.filter((r) => r.v.level === l).length]));
    const risk = new Set(sub.filter((r) => r.v.level === "C" || r.v.redline || r.v.double_zero)
      .map((r) => r.v.vendor_code));
    return {
      n: sub.length,
      avg: sub.reduce((s, r) => s + r.adjusted, 0) / (sub.length || 1),
      counts: c,
      sa: ((c.S + c.A) / (sub.length || 1)) * 100,
      risk: risk.size,
    };
  };
  const cityStats = cities.map((city) => ({ city, ...statOf(rows.filter((r) => r.v.city === city)) }));
  const cityRow = (label, s, bold) => `
    <tr>
      <td class="${bold ? "fw" : ""}">${label}</td>
      <td class="n num">${fmtNumber(s.n)}</td>
      <td class="n num ${bold ? "fw" : ""}">${fmtPoints(s.avg)}</td>
      ${LEVELS.map((l) => `<td class="n num">${s.counts[l] || "—"}</td>`).join("")}
      <td class="n num ${bold ? "fw" : ""}">${fmtNumber(s.sa, { maximumFractionDigits: 0 })}%</td>
      <td class="n num${s.risk ? " pf-risk" : ""}">${s.risk}</td>
    </tr>`;
  const byCity = cities.length < 2 ? "" : `
  <div class="card">
    <h3 class="fw" style="margin-bottom:12px">${t("portfolio.by_city_title")}</h3>
    <div class="table-scroll"><table>
      <thead><tr>
        <th>${t("portfolio.h.city")}</th><th class="n">${t("portfolio.h.count")}</th>
        <th class="n">${t("portfolio.h.avg_points")}</th>
        ${LEVELS.map((l) => `<th class="n">${l}</th>`).join("")}
        <th class="n">${t("portfolio.kpi_sa")}</th><th class="n">${t("portfolio.kpi_risk")}</th>
      </tr></thead>
      <tbody>
        ${cityStats.map((s) => cityRow(s.city, s, false)).join("")}
        ${cityRow(t("portfolio.total_row"), statOf(rows), true)}
      </tbody>
    </table></div>
  </div>`;

  // ---- 作用域切换：全部 / 各城。指标分布与逐家明细共用同一个切换 ----
  const scopes = [{ key: "all", label: t("portfolio.scope_all_btn"), sub: rows },
    ...cities.map((city) => ({ key: city, label: city, sub: rows.filter((r) => r.v.city === city) }))];
  const scopeBar = scopes.length < 2 ? "" : `
    <div class="pf-scope">
      ${scopes.map((s, i) => `<button type="button" class="scope-btn pf-scope-btn${i === 0 ? " active" : ""}"
        data-scope="${s.key}">${s.label} <span class="faint num">${s.sub.length}</span></button>`).join("")}
    </div>`;

  // ---- 各指标得分分布：每一档各多少家（只给平均分看不出结构） ----
  const distTable = (sub) => {
    const m = sub.length || 1;
    const stats = activeIndicators(rules).map((rule) => {
      const scores = sub.map((r) => r.scores[rule.key]);
      const tiers = [...new Set(scores)].length ? null : null;
      // 档位分值从规则里取（复合指标取其分项档位），不写死 100/80/50/0
      const tierScores = [...new Set((rule.composite
        ? rule.composite.components[0].tiers : rule.tiers).map((x) => x.score))].sort((a, b) => b - a);
      return {
        rule, tierScores,
        buckets: tierScores.map((sc) => scores.filter((x) => x === sc).length),
        avg: scores.reduce((a, b) => a + b, 0) / m,
        avgLoss: scores.reduce((a, s) => a + (100 - s) * rule.weight, 0) / m,
      };
    }).sort((a, b) => b.avgLoss - a.avgLoss);
    const allTiers = [...new Set(stats.flatMap((s) => s.tierScores))].sort((a, b) => b - a);
    return `
    <div class="table-scroll"><table>
      <thead><tr>
        <th>${t("portfolio.h.indicator")}</th>
        ${allTiers.map((sc) => `<th class="n">${t("advice.sim_tier_score", { score: fmtNumber(sc) })}</th>`).join("")}
        <th class="n">${t("portfolio.h.avg_score")}</th>
        <th class="n">${t("portfolio.h.avg_loss")}</th>
      </tr></thead>
      <tbody>
        ${stats.map((s) => `
        <tr>
          <td><span class="fw">${t(`indicator.${s.rule.key}`)}</span>
              <span class="faint small num"> ${fmtNumber(s.rule.weight * 100)}%</span></td>
          ${allTiers.map((sc) => {
            const i = s.tierScores.indexOf(sc);
            if (i < 0) return `<td class="n faint">—</td>`;
            const cnt = s.buckets[i];
            return `<td class="n num${sc === 0 && cnt ? " pf-risk" : ""}">${cnt
              ? `${cnt}<span class="faint small"> ${fmtNumber((cnt / m) * 100, { maximumFractionDigits: 0 })}%</span>`
              : `<span class="faint">0</span>`}</td>`;
          }).join("")}
          <td class="n num fw">${fmtNumber(s.avg, { maximumFractionDigits: 0 })}</td>
          <td class="n num">${fmtPoints(s.avgLoss)}</td>
        </tr>`).join("")}
      </tbody>
    </table></div>`;
  };

  const distByScore = `
  <div class="card">
    <div class="pf-head">
      <h3 class="fw">${t("portfolio.score_dist_title")}</h3>
      <span class="faint small">${t("portfolio.score_dist_note")}</span>
    </div>
    ${scopeBar}
    ${scopes.map((s, i) => `<div class="pf-scoped" data-scope="${s.key}"${i ? ' hidden' : ''}>${
      distTable(s.sub)}</div>`).join("")}
  </div>`;

  // ---- 逐家明细：按作用域分别排名（2026-08-16 用户要求分城看） ----
  const listRows = (sub) => sub.map((r, i) => {
    const flags = [
      r.v.redline ? `<span class="chip alert">${t("portfolio.risk_redline")}</span>` : "",
      r.v.double_zero ? `<span class="chip">${t("portfolio.risk_dz")}</span>` : "",
      r.prot.status === "exempt" ? `<span class="chip">${t("portfolio.risk_protected")}</span>` : "",
    ].join("");
    const chg = r.v.level_change === "↑" ? `<span class="pf-up">↑</span>`
      : r.v.level_change === "↓" ? `<span class="pf-down">↓</span>` : `<span class="faint">—</span>`;
    return `
    <tr class="pf-row" data-vendor="${r.v.vendor_code}" tabindex="0" role="button">
      <td class="n num faint">${i + 1}</td>
      <td><span class="fw num">${r.v.vendor_code}</span>
          <div class="faint small">${r.v.city}${isAll ? ` · ${r.p?.rm ?? t("common.rm_unassigned")}` : ""}</div></td>
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
    <div class="pf-head">
      <h3 class="fw">${t("portfolio.list_title")}</h3>
      <span class="faint small">${t("portfolio.sort_hint")}</span>
    </div>
    <p class="faint small" style="margin-bottom:12px">${t("portfolio.flags_legend")}</p>
    ${scopeBar}
    ${scopes.map((s, i) => `<div class="pf-scoped" data-scope="${s.key}"${i ? ' hidden' : ''}>
      <div class="table-scroll"><table>
        <thead><tr>
          <th class="n">${t("portfolio.h.rank")}</th>
          <th>${t("portfolio.h.vendor")}</th><th>${t("portfolio.h.level")}</th>
          <th class="n">${t("portfolio.h.points")}</th><th class="n">${t("portfolio.h.change")}</th>
          <th>${t("portfolio.h.weakest")}</th><th>${t("portfolio.h.flags")}</th><th></th>
        </tr></thead>
        <tbody>${listRows(s.sub)}</tbody>
      </table></div></div>`).join("")}
  </div>`;

  return `
  <section class="section">
    <h2 class="page-title">${isAll ? t("portfolio.title_all") : t("portfolio.title")}</h2>
    <p class="faint small" style="margin:10px 0 18px">${t("portfolio.subtitle", {
      scope: scopeLabel, n: fmtNumber(n), period: period.label })}</p>
    ${kpi}
    ${distBar}
    ${byCity}
    ${distByScore}
  </section>
  <section class="section">${list}</section>`;
}

/** 点行/点按钮 → 切到该商详情（由 app.js 提供跳转回调） */
export function bindPortfolio(onPick) {
  // 作用域切换（全部 / 各城）：指标分布与逐家明细共用。三份表格已在渲染时算好，
  // 这里只切显示——不在客户端重算，省得把数据再传一份进来、多一处可能不同步的状态
  document.querySelectorAll(".pf-scope-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const scope = btn.dataset.scope;
      document.querySelectorAll(".pf-scope-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.scope === scope));
      document.querySelectorAll(".pf-scoped").forEach((el) => {
        el.hidden = el.dataset.scope !== scope;
      });
    });
  });

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
