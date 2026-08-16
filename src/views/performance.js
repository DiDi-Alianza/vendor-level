// 指标明细页（需求文档 6.3）：每项一卡——指标名、口径说明（可展开）、实际值、所在档位、
// 各档阈值（完整标尺）、本项得分/满分、加权贡献。credit 为预计算复合分，单独形态。

import { t, fmtNumber, tUnit } from "../i18n.js";
import { computeScores, isCompositeInput } from "../engine/rules.js";
import { nextTierGain } from "../engine/advice.js";
import { tierTrackFull } from "../components/tiertrack.js";

export function renderPerformance({ rules, vendor }) {
  const values = Object.fromEntries(vendor.indicators.map((i) => [i.key, i.value]));
  const { scores, contributions } = computeScores(rules, values);

  const cards = rules.indicators.map((rule) => {
    const value = values[rule.key];
    const score = scores[rule.key];
    const head = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
        <h3 class="fw">${t(`indicator.${rule.key}`)}</h3>
        <div class="num muted">${t("perf.score_of", { score: fmtNumber(score) })}
          · <span class="fw" style="color:var(--ink)">${t("perf.contribution", {
              points: fmtNumber(contributions[rule.key], { maximumFractionDigits: 1 }) })}</span>
        </div>
      </div>
      <details class="desc"><summary>${t("perf.desc_toggle")}</summary>
        <p>${t(`indicator.${rule.key}.desc`)}${rule.proxy_notice_key ? `<br>${t(rule.proxy_notice_key)}` : ""}</p>
      </details>`;

    if (isCompositeInput(rule)) {
      // 复合指标展示「算出的得分」而不是原始值——原始值是对象（分项集合），不能直接格式化
      return `
      <div class="card">
        ${head}
        <div class="num-lg num" style="font-size:34px;margin-top:14px">${fmtNumber(score)}<span class="unit">${tUnit(rule)}</span></div>
        <p class="faint" style="margin-top:8px">${t("perf.credit_precomputed")}
          <a href="#/rules">${t("perf.see_rules")}</a></p>
      </div>`;
    }

    const gain = nextTierGain(rule, value, score);
    return `
    <div class="card">
      ${head}
      ${tierTrackFull(rule, value, score, gain)}
    </div>`;
  }).join("");

  return `
  <section class="section">
    <h2 class="page-title">${t("perf.title")}</h2>
  </section>
  <section class="section">${cards}</section>`;
}
