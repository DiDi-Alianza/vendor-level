// 提分分析 —— 纯函数，通用遍历 tiers，不含任何业务字面值。
// 供总览页「最需关注项」与建议页（后续）共用。

/**
 * 当前档与下一档信息。
 * @returns {null | { currentScore, nextScore, threshold, thresholdKind: 'gte'|'lt'|'lte', delta, gainPoints }}
 *  null = 预计算指标（无法从 value 推档）或已在最高档。
 */
import { isCompositeInput, tierThreshold, tierMatches } from "./rules.js";

export function nextTierGain(indicatorRule, value, currentScore) {
  // 复合指标（还款信用）没有顶层 tiers，档位在分项里，"下一档"语义不同 → 不提示。
  // 注意：旧写法额外判 typeof value === "number"，新口径数据的 credit 是对象 → 短路失效会崩（2026-08-14 踩过）
  if (isCompositeInput(indicatorRule)) return null;
  if (value === null || value === undefined) return null;

  if (indicatorRule.direction === "higher_better") {
    const tiers = [...indicatorRule.tiers].sort((a, b) => tierThreshold(b) - tierThreshold(a));
    const idx = tiers.findIndex((t) => tierMatches(t, value));
    if (idx <= 0) return null; // 已最高档
    const next = tiers[idx - 1];
    const threshold = tierThreshold(next);
    return {
      currentScore,
      nextScore: next.score,
      // gt 档要「超过」而不是「达到」，文案据此区分（A11 起三项越高越好指标的 50 分档是 gt）
      thresholdKind: "gt" in next ? "gt" : "gte",
      threshold,
      delta: threshold - value,
      gainPoints: (next.score - currentScore) * indicatorRule.weight,
    };
  }

  // lower_better：tiers 按声明顺序（最优档在前）
  const tiers = indicatorRule.tiers;
  const idx = tiers.findIndex((t) => tierMatches(t, value));
  if (idx <= 0) return null;
  const next = tiers[idx - 1];
  const kind = "lt" in next ? "lt" : "lte";
  const threshold = next[kind];
  return {
    currentScore,
    nextScore: next.score,
    threshold,
    thresholdKind: kind,
    delta: value - threshold,
    gainPoints: (next.score - currentScore) * indicatorRule.weight,
  };
}

/**
 * 最需关注项。双 0 分支 → 按分支 focus_indicators 顺序；默认分支 → 按提分性价比（gainPoints 降序）取前 limit 项。
 * @returns Array<{ key, rule, value, score, gain }>
 */
export function focusIndicators(rules, values, scores, branch, limit = 2) {
  const byKey = Object.fromEntries(rules.indicators.map((i) => [i.key, i]));
  if (branch?.focus_indicators) {
    return branch.focus_indicators.map((key) => ({
      key,
      rule: byKey[key],
      value: values[key],
      score: scores[key],
      gain: nextTierGain(byKey[key], values[key], scores[key]),
    }));
  }
  return rules.indicators
    .map((rule) => ({
      key: rule.key,
      rule,
      value: values[rule.key],
      score: scores[rule.key],
      gain: nextTierGain(rule, values[rule.key], scores[rule.key]),
    }))
    .filter((x) => x.gain !== null)
    .sort((a, b) => b.gain.gainPoints - a.gain.gainPoints)
    .slice(0, limit);
}
