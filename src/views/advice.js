// 改进建议页（需求文档 6.4）：默认分支（优势/薄弱/六项模拟器）与双 0 分支（两条路径 + 两滑块，
// 其余折叠）。分支判定走 rules.json advice_branches（按得分，不按等级）。语气激励，不指责。
// C 级商的清退提示严格区分保护期状态；首单缺失 → 不发警告。

import { t, fmtNumber, fmtPoints, fmtCurrency, tUnit } from "../i18n.js";
import {
  computeScores, determineLevel, adviceBranch, isCompositeInput,
  applyFlexAdjustment, estimateIncentive, activeIndicators, scoreIndicator, tierThreshold,
} from "../engine/rules.js";
import { protectionStatus } from "../engine/protection.js";
import { nextTierGain } from "../engine/advice.js";
import { badgeSmall } from "../components/badge.js";
import { tierTrackMini } from "../components/tiertrack.js";

const fmt1 = (n) => fmtNumber(n, { maximumFractionDigits: 1 });

/** 滑块范围由 tiers 推导（无业务字面值）：上界 = 最优/最差有界阈值 × 2 */
function sliderConfig(rule, value) {
  if (isCompositeInput(rule)) {
    return { min: 0, max: 100, step: 1 };
  }
  const bounded = rule.tiers
    .map((tr) => tr.gte ?? tr.gt ?? tr.lt ?? tr.lte)
    .filter((v) => v !== null && v !== undefined);
  const top = Math.max(...bounded);
  // 取值域上限来自 rules.json（如 Slot 达成率 ≤100%）；没声明的按最高档 ×2 推
  const max = rule.value_max ?? Math.max(top * 2, Math.ceil(value * 1.2));
  const step = max > 500 ? 10 : max > 50 ? 1 : 0.1;
  return { min: 0, max, step };
}

function simRow(rule, value, score, { hidden = false } = {}) {
  // 复合指标（还款信用）的原始值是对象 → 滑块直接调「得分」；引擎收到数值会按最终分直通
  const isComp = isCompositeInput(rule);
  const shown = isComp ? score : value;
  const cfg = sliderConfig(rule, shown);
  return simRowHTML(rule, shown, score, cfg, isComp);
}

/**
 * 档位区间：把 tiers 铺成 [from, to] 段，每段带该档得分。
 * higher_better 的阈值是区间**下界**、lower_better 是**上界**，两者分开推——不为任何指标写专用分支。
 */
export function tierSegments(rule, max) {
  if (rule.direction === "higher_better") {
    const asc = [...rule.tiers].sort((a, b) => tierThreshold(a) - tierThreshold(b));
    return asc.map((tr, i) => ({
      from: tierThreshold(tr),
      to: i + 1 < asc.length ? tierThreshold(asc[i + 1]) : max,
      score: tr.score,
    }));
  }
  // lower_better：声明序 = 好→差，阈值是本档上界；兜底档（null）延到量程上限
  let prev = 0;
  return rule.tiers.map((tr) => {
    const th = tierThreshold(tr);
    const to = th === null ? max : th;
    const seg = { from: prev, to, score: tr.score };
    prev = to;
    return seg;
  });
}

/**
 * 滑块下的档位刻度：每一档标出**得分**，边界标出阈值，当前档高亮。
 * 段宽按量程比例，但给一个下限——信用「无逾期」这种零宽档否则会看不见。
 */
function tierScaleHTML(rule, value, cfg, isComp) {
  // 复合指标的滑块调的是「得分」本身，量程 0–100，刻度直接标四个分档
  const segs = isComp
    ? [...new Set(rule.composite.components[0].tiers.map((tr) => tr.score))]
        .sort((a, b) => a - b)
        .map((sc, i, arr) => ({ from: sc, to: i + 1 < arr.length ? arr[i + 1] : 100, score: sc }))
    : tierSegments(rule, cfg.max);
  const raw = segs.map((s) => Math.max(s.to - s.from, 0) / (cfg.max || 1));
  const MIN = 0.1;                                  // 零宽/极窄档的最小可见宽度
  const lifted = raw.map((w) => Math.max(w, MIN));
  const sum = lifted.reduce((a, b) => a + b, 0) || 1;
  const widths = lifted.map((w) => (w / sum) * 100);
  const cur = isComp ? value : scoreIndicator(rule, value);
  // 档位配色跟着「该档得分」走（0→t1 … 满分→t4），与指标明细页的档位标尺同一套蓝阶。
  // 按得分而不是按位置：越低越好的指标最优档在左、越高越好的在右，按位置会导致两类指标颜色反向。
  const ranked = [...new Set(segs.map((s) => s.score))].sort((a, b) => a - b);
  const inSeg = (s, i, v) => (isComp
    // 复合指标（还款信用）滑块调的是得分本身，取值连续 → 必须按区间包含判定，
    // 不能按「段位得分 === 当前得分」，否则拖到 63 这种中间值时全部不高亮
    ? v >= s.from && (i === segs.length - 1 || v < s.to)
    : s.score === v);
  const bars = segs.map((s, i) => `
    <div class="sim-seg t${ranked.indexOf(s.score) + 1}${s.score === 0 ? " zero" : ""}${
      inSeg(s, i, cur) ? " current" : ""}"
      data-score="${s.score}" data-from="${s.from}" data-to="${i === segs.length - 1 ? "" : s.to}"
      style="width:${widths[i].toFixed(2)}%">
      <b class="num">${t("advice.sim_tier_score", { score: fmtNumber(s.score) })}</b>
    </div>`).join("");
  // 边界刻度：段与段的交界值（首段起点与量程上限不标，避免过密）
  let acc = 0;
  const ticks = segs.map((s, i) => {
    const left = acc; acc += widths[i];
    return i === 0 ? "" :
      `<span class="sim-tick num" style="left:${left.toFixed(2)}%">${fmtNumber(s.from)}</span>`;
  }).join("");
  return `
    <div class="sim-scale" data-key="${rule.key}">
      <div class="sim-scale-bars">${bars}</div>
      <div class="sim-scale-ticks">${ticks}</div>
    </div>`;
}

function simRowHTML(rule, value, score, cfg, isComp) {
  return `
  <div class="sim-row">
    <div class="sim-head">
      <span class="fw">${t(`indicator.${rule.key}`)}
        ${isComp ? `<span class="faint">${t("common.paren_open")}${t("advice.sim_credit_note")}${t("common.paren_close")}</span>` : ""}
      </span>
      <span class="num muted">
        <span id="sim-value-${rule.key}">${fmt1(value)}</span> ${tUnit(rule)}
        · <span class="fw" id="sim-score-${rule.key}">${fmtNumber(score)}</span>/100
      </span>
    </div>
    <input type="range" id="sim-slider-${rule.key}" data-key="${rule.key}"
      min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${value}"
      aria-label="${t(`indicator.${rule.key}`)}">
    ${tierScaleHTML(rule, value, cfg, isComp)}
    <p class="faint small sim-next" id="sim-next-${rule.key}"></p>
  </div>`;
}

/** 预估激励：模拟等级 × 模拟完美单量（单量本身也随滑块变）× 单价，含封顶；红线冻结计 0 */
function bonusOf(rules, level, values, period, redline) {
  const key = rules.s_scale_gate.indicator;      // 完美单指标的 key（门槛停用后仍是这一项）
  const monthly = (values[key] ?? 0) * period.days;
  const est = estimateIncentive(rules, level, monthly, { redline });
  return { amount: est.frozen ? 0 : est.amount, capped: est.capped, frozen: est.frozen, rate: rules.incentive.rates[level] };
}

/**
 * 「一步就能升级」提示：逐项算「提到下一档后综合分能否跨过下一等级线」。
 * 只列单项即可达成的（最可操作）；都不够时说明总差距，不给假希望。
 */
/** 下一等级目标线（C 级的目标是脱离 C，即达到 C 线进入 B）。S 级无目标 → null */
function nextTarget(rules, vendor) {
  const lines = { ...rules.level_lines.shared, ...rules.level_lines.by_city[vendor.city] };
  return vendor.level === "S" ? null
    : vendor.level === "A" ? { level: "S", line: lines.S }
    : vendor.level === "B" ? { level: "A", line: lines.A }
    : { level: "B", line: lines.C };
}

function upgradeHints(rules, vendor, values, scores, total) {
  const target = nextTarget(rules, vendor);
  if (!target) {
    // S 之上没有等级，但激励仍随完美单量线性增长（到封顶为止）——这才是 S 级商真正的下一步
    const inc = rules.incentive;
    return `<p class="muted">${t("advice.upgrade_hint_top_bonus", {
      rate: fmtCurrency(inc.rates.S, inc.currency),
      cap: fmtCurrency(inc.per_vendor_monthly_cap, inc.currency),
    })}</p>`;
  }

  const rows = [];
  for (const rule of activeIndicators(rules)) {
    const gain = nextTierGain(rule, values[rule.key], scores[rule.key]);
    if (!gain) continue;
    const after = total + gain.gainPoints;
    if (after >= target.line) {
      rows.push({ rule, gain, after });
    }
  }
  if (!rows.length) {
    return `<p class="muted">${t("advice.upgrade_hint_none", {
      level: target.level, gap: fmtPoints(target.line - total) })}</p>`;
  }
  rows.sort((a, b) => Math.abs(a.gain.delta) - Math.abs(b.gain.delta)); // 差得最少的排前面
  return `<ul style="padding-left:20px" class="muted">${rows.map(({ rule, gain, after }) => `
    <li style="margin-bottom:6px">${t("advice.upgrade_hint_row", {
      indicator: t(`indicator.${rule.key}`),
      threshold: fmtNumber(gain.threshold),
      unit: tUnit(rule),
      value: fmt1(values[rule.key]),
      from: fmtPoints(total),
      to: fmtPoints(after),
      level: target.level,
    })}</li>`).join("")}</ul>`;
}

function simulatorSection(rules, vendor, values, scores, branch, period) {
  const isDz = branch?.key === "double_zero";
  const focusKeys = isDz ? branch.focus_indicators : rules.indicators.map((i) => i.key);
  const mainRows = rules.indicators
    .filter((r) => focusKeys.includes(r.key))
    .map((r) => simRow(r, values[r.key], scores[r.key]))
    .join("");
  const otherRows = isDz
    ? `<details style="margin-top:10px"><summary class="faint" style="cursor:pointer">${t("advice.dz_others")}</summary>
       ${rules.indicators.filter((r) => !focusKeys.includes(r.key))
         .map((r) => simRow(r, values[r.key], scores[r.key])).join("")}</details>`
    : "";
  const flexKnown = applyFlexAdjustment(rules, 0, vendor.flex_adjustments ?? []);
  const flexNote = (flexKnown.bonus || flexKnown.penalty)
    ? `<p class="small muted" style="margin-top:10px">${t("advice.sim_flex_note", {
        bonus: fmtNumber(flexKnown.bonus), penalty: fmtNumber(flexKnown.penalty) })}</p>`
    : "";
  const cap = rules.redline?.level_cap;
  const redlineNote = vendor.redline && cap
    ? `<p class="small" style="color:var(--alert);margin-top:10px">${t("advice.sim_redline_note", { cap })}</p>`
    : "";

  // Bonus 实时联动（2026-08-14 用户要求）：拖动滑块时激励金额随「等级 × 完美单量」一起变
  const baseTotal = applyFlexAdjustment(rules, vendor.total_score, vendor.flex_adjustments ?? []).adjusted;
  const b0 = bonusOf(rules, vendor.level, values, period, vendor.redline);
  const bonusBlock = `
    <div class="sim-bonus">
      <span class="faint small">${t("advice.sim_bonus_label")}</span>
      <div class="sim-bonus-amount num${b0.rate > 0 || b0.frozen ? "" : " as-text"}" id="sim-bonus">${
        b0.frozen ? fmtCurrency(0, rules.incentive.currency)
        : b0.rate > 0 ? fmtCurrency(b0.amount, rules.incentive.currency)
        : t("advice.sim_bonus_none")}</div>
      <div class="faint small" id="sim-bonus-note">${
        b0.frozen ? t("advice.sim_bonus_frozen")
        : t("advice.sim_bonus_note", { cap: fmtCurrency(rules.incentive.per_vendor_monthly_cap, rules.incentive.currency) })}</div>
    </div>`;

  return `
  <section class="section">
    <h2>${t("advice.sim_title")}</h2>
    <div class="card">
      <p class="faint small">${t("advice.sim_hint")}</p>
      <div class="sim-result num">
        <span>
          <span class="faint small">${t("advice.sim_current")}</span><br>
          <span class="badge-inline">${badgeSmall(vendor.level, 24)} <span class="sim-points">${fmtPoints(applyFlexAdjustment(rules, vendor.total_score, vendor.flex_adjustments ?? []).adjusted)}</span></span>
        </span>
        <span class="arrow" aria-hidden="true">→</span>
        <span>
          <span class="faint small">${t("advice.sim_simulated")}</span><br>
          <span class="badge-inline"><span id="sim-badge">${badgeSmall(vendor.level, 24)}</span>
          <span class="sim-points" id="sim-points">${fmtPoints(applyFlexAdjustment(rules, vendor.total_score, vendor.flex_adjustments ?? []).adjusted)}</span></span>
        </span>
        <button class="btn" id="sim-reset" type="button" style="margin-left:auto">${t("advice.sim_reset")}</button>
      </div>
      ${bonusBlock}
      ${flexNote}
      ${redlineNote}
      ${mainRows}
      ${otherRows}
      <div class="sim-upgrade">
        <h3 class="fw" style="margin-bottom:8px">${t("advice.upgrade_hint_title")}</h3>
        <div id="upgrade-hints">${upgradeHints(rules, vendor, values, scores, baseTotal)}</div>
      </div>
    </div>
  </section>`;
}

function clearanceSection(rules, vendor, profile, period) {
  if (vendor.level !== "C") return "";
  // 周度试算不计入清退累计（数据侧 clearance_count=null），不发任何清退提示
  if (period.type === "weekly") {
    return `<section class="section"><div class="card"><p class="muted">${t("advice.weekly_no_clearance")}</p></div></section>`;
  }
  const prot = protectionStatus(profile?.first_order_date ?? null, period.month, rules.new_vendor_protection);
  let body;
  if (prot.status === "exempt" || prot.status === "pre_start") {
    body = t("advice.clearance_exempt", { until: prot.exemptMonths[prot.exemptMonths.length - 1] ?? "" });
  } else if (prot.status === "counted") {
    body = `${t("advice.clearance_counting", {
      start: fmtNumber(rules.new_vendor_protection.exempt_months + 1),
      months: fmtNumber(rules.clearance.consecutive_c_months),
      n: fmtNumber(prot.monthNumber),
    })}<br><span class="faint">${t("advice.clearance_history_note")}</span>`;
  } else {
    body = t("advice.clearance_unknown");
  }
  return `
  <section class="section">
    <div class="card"><p class="muted">${body}</p></div>
  </section>`;
}

function defaultBranch(rules, vendor, values, scores) {
  const strengths = rules.indicators
    .filter((r) => scores[r.key] >= 80)
    .map((r) => `<span class="chip">${t(`indicator.${r.key}`)} · <span class="num">${fmtNumber(scores[r.key])}</span></span>`)
    .join("");
  const weak = rules.indicators
    .map((r) => ({ r, gain: nextTierGain(r, values[r.key], scores[r.key]) }))
    .filter((x) => x.gain !== null && scores[x.r.key] <= 50)
    .sort((a, b) => b.gain.gainPoints - a.gain.gainPoints);

  const weakCards = weak.length
    ? weak.map(({ r, gain }) => `
      <div class="card">
        <h3 class="fw">${t(`indicator.${r.key}`)}</h3>
        <p class="muted small" style="margin:8px 0 4px">${t("advice.weak_row", {
          value: fmt1(values[r.key]), unit: tUnit(r),
          threshold: fmtNumber(gain.threshold),
          from: fmtNumber(gain.currentScore), to: fmtNumber(gain.nextScore),
          gain: fmt1(gain.gainPoints),
        })}</p>
        ${tierTrackMini(r, values[r.key], scores[r.key], gain)}
      </div>`).join("")
    : `<div class="card muted">${t("advice.no_weak")}</div>`;

  return `
  <section class="section">
    <h2>${t("advice.strengths")}</h2>
    <div class="card">
      <p class="faint small" style="margin-bottom:12px">${t("advice.strengths_hint")}</p>
      <div class="strength-chips">${strengths}</div>
    </div>
  </section>
  <section class="section">
    <h2>${t("advice.weak")}</h2>
    ${weakCards}
  </section>`;
}

function doubleZeroBranch(rules, vendor, values, scores, branch) {
  const qualityOk = ["credit", "d3r", "blocked_rider_rate"].every((k) => scores[k] >= 80);
  const pathCard = (key, titleKey) => {
    const rule = rules.indicators.find((i) => i.key === key);
    const gain = nextTierGain(rule, values[key], scores[key]);
    return `
    <div class="card">
      <h3 class="fw">${t(titleKey)}</h3>
      <p class="muted small" style="margin:8px 0 4px">${gain ? t("advice.dz_path_detail", {
        value: fmt1(values[key]), unit: tUnit(rule),
        threshold: fmtNumber(gain.threshold), score: fmtNumber(gain.nextScore),
        gain: fmt1(gain.gainPoints),
      }) : ""}</p>
      ${tierTrackMini(rule, values[key], scores[key], gain)}
    </div>`;
  };
  return `
  <section class="section">
    <h2>${t("advice.dz_title")}</h2>
    <div class="card">
      <p class="muted">${t("advice.dz_intro")}</p>
      ${qualityOk ? `<p class="fw" style="margin-top:8px">${t("advice.dz_quality_ok")}</p>` : ""}
    </div>
    <div class="focus-grid" style="margin-top:16px">
      ${pathCard("slot", "advice.dz_path_slot")}
      ${pathCard("orders", "advice.dz_path_orders")}
    </div>
  </section>`;
}

export function renderAdvice({ rules, vendor, profile, period }) {
  const values = Object.fromEntries(vendor.indicators.map((i) => [i.key, i.value]));
  const { scores } = computeScores(rules, values);
  const branch = adviceBranch(rules, scores);
  const isDz = branch?.key === "double_zero";

  return `
  <section class="section">
    <h2 class="page-title">${t("advice.title")}</h2>
  </section>
  ${isDz ? doubleZeroBranch(rules, vendor, values, scores, branch) : defaultBranch(rules, vendor, values, scores)}
  ${simulatorSection(rules, vendor, values, scores, branch, period)}
  ${clearanceSection(rules, vendor, profile, period)}`;
}

/** 模拟器交互：input 只做定点更新，不整页重渲染（保持滑块焦点） */
export function bindAdvice({ rules, vendor, period }) {
  // 复合指标基线取「得分」而非原始对象——滑块调的是分数，引擎收到数值按最终分直通
  const ruleOf = (key) => rules.indicators.find((r) => r.key === key);
  const baseline = Object.fromEntries(vendor.indicators.map((i) => {
    const rule = ruleOf(i.key);
    return [i.key, rule && isCompositeInput(rule) ? i.score : i.value];
  }));
  const simValues = { ...baseline };
  // 灵活分是已知输入：模拟结果已包含它，不会被事后推翻
  const flexEntries = vendor.flex_adjustments ?? [];

  function refresh() {
    const { scores, total } = computeScores(rules, simValues);
    const flex = applyFlexAdjustment(rules, total, flexEntries);
    const { level } = determineLevel(rules, vendor.city, flex.adjusted, simValues, { redline: vendor.redline });
    for (const [key, s] of Object.entries(scores)) {
      const el = document.getElementById(`sim-score-${key}`);
      if (el) el.textContent = fmtNumber(s);
      // 档位刻度：当前所在档跟着高亮，让「现在落在哪一档、拿几分」一眼可见
      const scale = document.querySelector(`.sim-scale[data-key="${key}"]`);
      if (scale) {
        const rule0 = ruleOf(key);
        // 复合指标的滑块值就是得分（连续取值）→ 按区间包含判定；普通指标按档位得分相等判定
        const byRange = rule0 && isCompositeInput(rule0);
        const v = byRange ? simValues[key] : s;
        scale.querySelectorAll(".sim-seg").forEach((seg) => {
          const hit = byRange
            ? v >= Number(seg.dataset.from) && (seg.dataset.to === "" || v < Number(seg.dataset.to))
            : Number(seg.dataset.score) === v;
          seg.classList.toggle("current", hit);
        });
      }
      // 「再加多少就进下一档」——把提分动作说成具体数字，而不是让商家自己看刻度估
      const nextEl = document.getElementById(`sim-next-${key}`);
      const rule = ruleOf(key);
      if (nextEl && rule) {
        const gain = isCompositeInput(rule) ? null : nextTierGain(rule, simValues[key], s);
        const base = gain
          ? t("advice.sim_next_tier", {
              delta: fmt1(Math.abs(gain.delta)), unit: tUnit(rule),
              threshold: fmtNumber(gain.threshold), score: fmtNumber(gain.nextScore),
              gain: fmtPoints(gain.gainPoints),
            })
          : (s >= 100 ? t("advice.sim_at_top_tier") : "");
        // 这一项单独提到下一档就能跨过下一等级线 → 就地标出来，不用再去下面对照汇总
        const target = nextTarget(rules, vendor);
        const canUpgrade = !!gain && !!target && flex.adjusted + gain.gainPoints >= target.line;
        nextEl.textContent = base;
        nextEl.classList.toggle("can-upgrade", canUpgrade);
        if (canUpgrade) {
          const mark = document.createElement("b");
          mark.className = "sim-upgrade-mark";
          mark.textContent = t("advice.sim_row_upgrade", { level: target.level });
          nextEl.append(" ", mark);
        }
      }
    }
    const pointsEl = document.getElementById("sim-points");
    if (pointsEl) pointsEl.textContent = fmtPoints(flex.adjusted);
    const badgeEl = document.getElementById("sim-badge");
    if (badgeEl) badgeEl.innerHTML = badgeSmall(level, 24);

    // Bonus 随「模拟等级 × 模拟完美单量」联动（用户要求：加强感知）
    const bEl = document.getElementById("sim-bonus");
    const bNote = document.getElementById("sim-bonus-note");
    if (bEl && period) {
      const b = bonusOf(rules, level, simValues, period, vendor.redline);
      const base = bonusOf(rules, vendor.level, baseline, period, vendor.redline);
      bEl.textContent = b.frozen ? fmtCurrency(0, rules.incentive.currency)
        : b.rate > 0 ? fmtCurrency(b.amount, rules.incentive.currency)
        : t("advice.sim_bonus_none");
      // 「无现金激励」是一句话不是金额，切到正常字号（B/C 级模拟到 A/S 时会变回金额）
      bEl.classList.toggle("as-text", !(b.rate > 0 || b.frozen));
      bEl.classList.toggle("up", !b.frozen && b.amount > base.amount);
      bEl.classList.toggle("down", !b.frozen && b.amount < base.amount);
      if (bNote && !b.frozen) {
        const delta = b.amount - base.amount;
        bNote.textContent = delta === 0
          ? t("advice.sim_bonus_note", { cap: fmtCurrency(rules.incentive.per_vendor_monthly_cap, rules.incentive.currency) })
          : t("advice.sim_bonus_delta", {
              delta: `${delta > 0 ? "+" : "−"}${fmtCurrency(Math.abs(delta), rules.incentive.currency)}`,
            });
      }
    }

    // 升级提示随模拟值重算（拖动后哪些单项还能一步升级会变）
    const hintsEl = document.getElementById("upgrade-hints");
    if (hintsEl) hintsEl.innerHTML = upgradeHints(rules, vendor, simValues, scores, flex.adjusted);
  }

  document.querySelectorAll("input[type=range][data-key]").forEach((slider) => {
    slider.addEventListener("input", () => {
      const key = slider.dataset.key;
      simValues[key] = Number(slider.value);
      const vEl = document.getElementById(`sim-value-${key}`);
      if (vEl) vEl.textContent = fmt1(simValues[key]);
      refresh();
    });
  });

  document.getElementById("sim-reset")?.addEventListener("click", () => {
    Object.assign(simValues, baseline);
    document.querySelectorAll("input[type=range][data-key]").forEach((slider) => {
      slider.value = baseline[slider.dataset.key];
      const vEl = document.getElementById(`sim-value-${slider.dataset.key}`);
      if (vEl) vEl.textContent = fmt1(baseline[slider.dataset.key]);
    });
    refresh();
  });

  // 首屏先跑一次：「再加多少进下一档」的提示不该等到用户拖了滑块才出现
  refresh();
}
