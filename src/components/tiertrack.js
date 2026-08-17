// 档位标尺（数据区构件，蓝阶，不上橙）。本文件不含业务字面值：档位与阈值全部来自 indicatorRule。
// 迷你版：总览页用。完整版/可拖拽版（明细页、模拟器）后续在此基础上扩展。

import { t, fmtNumber, tUnit } from "../i18n.js";
import { tierThreshold, tierMatches } from "../engine/rules.js";

/** 档位按"从差到好"排序返回 [{label, score, isCurrent}] 与当前档序号 */
function orderedTiers(rule, value) {
  if (rule.direction === "higher_better") {
    const asc = [...rule.tiers].sort((a, b) => tierThreshold(a) - tierThreshold(b));
    const desc = [...asc].reverse();
    const curIdx = desc.findIndex((tr) => tierMatches(tr, value));
    const currentTier = desc[curIdx];
    return asc.map((tr) => ({
      threshold: tierThreshold(tr),
      score: tr.score,
      isCurrent: tr === currentTier,
    }));
  }
  // lower_better：声明序 = 好→差；从差到好 = 反转
  const declared = rule.tiers;
  const curIdx = declared.findIndex((tr) => tierMatches(tr, value));
  const currentTier = declared[curIdx];
  return [...declared].reverse().map((tr) => ({
    threshold: tierThreshold(tr),
    score: tr.score,
    isCurrent: tr === currentTier,
  }));
}

/** 指针位置（0–1）：分段等宽，段内按阈值线性插值；开放段用相邻段跨度外推 */
function pointerPosition(rule, value) {
  const tiers = orderedTiers(rule, value);
  const n = tiers.length;
  const idx = tiers.findIndex((tr) => tr.isCurrent);
  // 段边界（从差到好方向的数值边界）
  const bounds = tiers.map((tr) => tr.threshold);
  const ascending = rule.direction === "higher_better";
  let lo, hi;
  if (ascending) {
    lo = bounds[idx] ?? 0;
    hi = idx + 1 < n ? bounds[idx + 1] : lo + Math.abs(lo - (bounds[idx - 1] ?? 0)) || lo * 2 || 1;
  } else {
    // lower_better 从差到好：边界是上限，方向反转
    hi = bounds[idx];
    lo = idx + 1 < n ? bounds[idx + 1] : null;
    if (hi === null) { // 最差开放段
      const ref = bounds[idx + 1] ?? 1;
      hi = ref * 2;
    }
    if (lo === null) lo = 0;
    const frac = hi === lo ? 0.5 : Math.min(1, Math.max(0, (hi - value) / (hi - lo)));
    return (idx + frac) / n;
  }
  const frac = hi === lo ? 0.5 : Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
  return (idx + frac) / n;
}

/**
 * 完整档位标尺（指标明细页）：指针 + 值标签 + 档位边界刻度。
 */
export function tierTrackFull(rule, value, score, gain) {
  const tiers = orderedTiers(rule, value);
  const n = tiers.length;
  const segClasses = ["t1", "t2", "t3", "t4"];
  const segs = tiers
    .map((tier, i) =>
      `<div class="seg ${segClasses[Math.min(i, segClasses.length - 1)]}${
        tier.isCurrent ? " current" : ""}${tier.score === 0 ? " zero" : ""}"
            style="flex:1"></div>`)
    .join("");
  // 每段标出该档得分：让商家一眼看到「做到哪一档拿几分」（2026-08-14 用户要求）
  const scoreMarks = tiers.map((tier, i) =>
    `<span class="tier-score${tier.isCurrent ? " current" : ""}${tier.score === 0 ? " zero" : ""}"
           style="left:${(((i + 0.5) / tiers.length) * 100).toFixed(1)}%">${
      t("track.tier_label", { score: fmtNumber(tier.score) })}</span>`).join("");
  // 边界刻度：第 i 段（i≥1）的左边界
  // 两个方向下，第 i 段（差→好序，i≥1）与前一段的边界值都等于该段自身的 threshold
  const ticks = tiers.slice(1).map((tier, i) => {
    const pos = ((i + 1) / n) * 100;
    return `<span class="tick" style="left:${pos}%">${tier.threshold === null ? "" : fmtNumber(tier.threshold)}</span>`;
  }).join("");
  const pos = Math.min(96, Math.max(4, pointerPosition(rule, value) * 100)); // 夹住边缘，防标签溢出卡片
  const gapLine = gain
    ? `<div class="track-gap">${t("track.next_tier", {
        threshold: fmtNumber(gain.threshold),
        unit: tUnit(rule),
        delta: fmtNumber(Math.abs(gain.delta), { maximumFractionDigits: 1 }),
        gain: fmtNumber(gain.gainPoints, { maximumFractionDigits: 1 }),
      })}</div>`
    : "";
  const zeroWarn = tiers.find((x) => x.isCurrent)?.score === 0
    ? `<div class="zero-warn">${t("advice.tier_zero_warn")}</div>` : "";
  return `
  <div class="tier-track full">
    <div class="pointer-row">
      <span class="pointer num" style="left:${pos}%">${fmtNumber(value, { maximumFractionDigits: 1 })} ${tUnit(rule)}<i></i></span>
    </div>
    <div class="bar">${segs}</div>
    <div class="scores num">${scoreMarks}</div>
    <div class="ticks">${ticks}</div>
    ${gapLine}
    ${zeroWarn}
  </div>`;
}

/**
 * 迷你档位标尺。gain 来自 engine/advice.js 的 nextTierGain（可为 null）。
 */
export function tierTrackMini(rule, value, score, gain) {
  const tiers = orderedTiers(rule, value);
  const segClasses = ["t1", "t2", "t3", "t4"];
  const segs = tiers
    .map((tier, i) =>
      `<div class="seg ${segClasses[Math.min(i, segClasses.length - 1)]}${
        tier.isCurrent ? " current" : ""}${tier.score === 0 ? " zero" : ""}"
            style="flex:1" title="${fmtNumber(tier.score)}"></div>`)
    .join("");

  const gapLine = gain
    ? `<div class="track-gap">${t("track.next_tier", {
        threshold: fmtNumber(gain.threshold),
        unit: tUnit(rule),
        delta: fmtNumber(Math.abs(gain.delta), { maximumFractionDigits: 1 }),
        gain: fmtNumber(gain.gainPoints, { maximumFractionDigits: 1 }),
      })}</div>`
    : "";

  // 当前值指针 + 档位边界刻度：不给指针就看不出自己在档内的什么位置（用户反馈 2026-08-13）
  const pos = Math.min(96, Math.max(4, pointerPosition(rule, value) * 100));
  const n = tiers.length;
  const ticks = tiers.slice(1).map((tier, i) =>
    `<span class="tick" style="left:${(((i + 1) / n) * 100).toFixed(1)}%">${
      tier.threshold === null ? "" : fmtNumber(tier.threshold)}</span>`).join("");

  return `
  <div class="tier-track with-pointer">
    <div class="pointer-row">
      <span class="pointer num" style="left:${pos}%">${
        fmtNumber(value, { maximumFractionDigits: 1 })} ${tUnit(rule)}<i></i></span>
    </div>
    <div class="bar">${segs}</div>
    <div class="ticks">${ticks}</div>
    <div class="track-label faint">
      ${t("track.score", { score: fmtNumber(score), weight: fmtNumber(rule.weight * 100) })}
    </div>
    ${gapLine}
  </div>`;
}
