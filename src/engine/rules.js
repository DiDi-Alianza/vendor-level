// 通用规则引擎。唯一事实来源是 data/rules.json —— 本文件不含任何权重/阈值/分数线/单价字面值。
// 浏览器与 Bun 脚本（scripts/recalc.js、tests/）共用这一份实现。

const WEIGHT_EPSILON = 1e-9;

/** 启用的指标（支持编辑器停用：enabled === false 即停用，缺省视为启用） */
export function activeIndicators(rules) {
  return rules.indicators.filter((ind) => ind.enabled !== false);
}

/** 复合输入指标（如还款信用）：有 composite 定义、无顶层 tiers */
export function isCompositeInput(ind) {
  return ind.input_type === "composite" || (!!ind.composite && !Array.isArray(ind.tiers));
}

/**
 * 加载校验：启用指标的权重之和必须为 1.0，不等则拒绝启动。
 * 错误以 { code, params } 抛出，由 UI 层走 i18n 翻译成人话。
 */
export function validateRules(rules) {
  const active = activeIndicators(rules);
  const sum = active.reduce((acc, ind) => acc + ind.weight, 0);
  if (Math.abs(sum - 1.0) > WEIGHT_EPSILON) {
    const err = new Error(`indicator weights sum to ${sum}, expected 1.0`);
    err.code = "rules.weight_sum_invalid";
    err.params = { sum, expected: 1.0 };
    throw err;
  }
  for (const ind of active) {
    if (isCompositeInput(ind)) continue;
    if (!Array.isArray(ind.tiers) || ind.tiers.length === 0) {
      const err = new Error(`indicator ${ind.key} has no tiers`);
      err.code = "rules.tiers_missing";
      err.params = { indicator: ind.key };
      throw err;
    }
  }
  return rules;
}

/**
 * 档位门槛值（与算子无关）。higher_better 用 gte/gt，lower_better 用 lt/lte（null = 兜底档）。
 * 排序、标尺、建议、公示表全部经此函数取值——各处再自己写 tier.gte 就会在混用算子时静默出错。
 */
export function tierThreshold(tier) {
  if ("gte" in tier) return tier.gte;
  if ("gt" in tier) return tier.gt;
  if ("lt" in tier) return tier.lt;
  return tier.lte;
}

/**
 * 档位是否命中。gt / lt 为严格比较，gte / lte 含边界。
 * CR-20260814 A11：0 分档一律含边界（公示时边界归属必须明确），
 * 于是越高越好的三项第三档改用 gt——边界值落进 0 分档而不是 50 分档。
 */
export function tierMatches(tier, value) {
  if ("gte" in tier) return value >= tier.gte;
  if ("gt" in tier) return value > tier.gt;
  if ("lt" in tier) return tier.lt === null || value < tier.lt;
  return tier.lte === null || value <= tier.lte;
}

/**
 * 单项打分。按 direction 通用判定，不为任何指标写专用分支：
 *  - higher_better：tiers 用 gte（含边界）或 gt（严格大于），按门槛从高到低取第一个命中的档
 *  - lower_better：tiers 用 lt / lte（null = 兜底档），按声明顺序取第一个命中的档
 *  - 复合输入指标（如还款信用）：value 为对象 {overdue_ratio, bad_debt_ratio} 或 {no_debt:true}
 *    时按分项档位复合计算；为数值时视为已算好的最终分（7 月演示数据形态，兼容）
 */
export function scoreIndicator(indicatorRule, value) {
  if (isCompositeInput(indicatorRule)) {
    if (typeof value === "number") return value;
    if (value && typeof value === "object") {
      const res = scoreComposite(indicatorRule, value, { noDebt: value.no_debt === true });
      return typeof res === "number" ? res : res.score;
    }
  }
  if (value === null || value === undefined) {
    // 指标可显式声明「分母为 0 / 无数据时计几分」（如拉新率：当月未招骑手 → 0 分）。
    // 没声明就抛错——绝不静默把缺失值当 0，那会让数据缺口变成"看起来正常的低分"。
    if (indicatorRule.null_value_score !== undefined) return indicatorRule.null_value_score;
    const err = new Error(`missing value for indicator ${indicatorRule.key}`);
    err.code = "engine.value_missing";
    err.params = { indicator: indicatorRule.key };
    throw err;
  }
  if (indicatorRule.direction === "higher_better") {
    const tiers = [...indicatorRule.tiers].sort((a, b) => tierThreshold(b) - tierThreshold(a));
    for (const t of tiers) {
      if (tierMatches(t, value)) return t.score;
    }
    return tiers[tiers.length - 1].score;
  }
  // lower_better：声明顺序 = 好→差，取第一个命中的档
  for (const t of indicatorRule.tiers) {
    if (tierMatches(t, value)) return t.score;
  }
  const err = new Error(`no tier matched for ${indicatorRule.key} value=${value}`);
  err.code = "engine.no_tier_matched";
  err.params = { indicator: indicatorRule.key, value };
  throw err;
}

/**
 * 复合指标打分（如欠款信用分：逾期占比 60% + 坏账率 40%）。
 * components: { [componentKey]: 原始值 }；noDebt=true 时直接取 composite.no_debt_score。
 * 分项档位与权重全部来自 rules.json 的 indicator.composite，本函数无任何字面值。
 */
export function scoreComposite(indicatorRule, components, { noDebt = false } = {}) {
  const comp = indicatorRule.composite;
  if (!comp) {
    const err = new Error(`indicator ${indicatorRule.key} has no composite definition`);
    err.code = "rules.composite_missing";
    err.params = { indicator: indicatorRule.key };
    throw err;
  }
  if (noDebt) return comp.no_debt_score;
  let total = 0;
  const parts = {};
  for (const c of comp.components) {
    const s = scoreIndicator(c, components[c.key]);
    parts[c.key] = s;
    total += s * c.weight;
  }
  return { score: total, parts };
}

/**
 * 逐项打分 + 综合分。values: { [indicatorKey]: 原始值 }。
 * 返回 { scores: {key: 单项得分}, contributions: {key: 得分×权重}, total }
 */
export function computeScores(rules, values) {
  const scores = {};
  const contributions = {};
  let total = 0;
  for (const ind of activeIndicators(rules)) {
    const s = scoreIndicator(ind, values[ind.key]);
    scores[ind.key] = s;
    contributions[ind.key] = s * ind.weight;
    total += s * ind.weight;
  }
  return { scores, contributions, total };
}

/**
 * 灵活分：按商条目分别汇总加分与扣分，净值夹在 ±max_abs 内。
 * entries: [{value, type: "activity_bonus"|"penalty", reason_key}]；无配置或无条目 → 全零。
 * 返回 { bonus, penalty, net, adjusted }（adjusted = base + net）。
 * 计算顺序见 rules.flex_adjustment.application_order：净值只影响综合分，
 * S 规模门槛与红线封顶仍是硬约束（在 determineLevel 中后置执行）。
 */
export function applyFlexAdjustment(rules, baseTotal, entries = []) {
  const cfg = rules.flex_adjustment;
  if (!cfg || !entries.length) return { bonus: 0, penalty: 0, net: 0, adjusted: baseTotal };
  let bonus = 0, penalty = 0;
  for (const e of entries) {
    if (e.type === "activity_bonus") bonus += Math.abs(e.value);
    else if (e.type === "penalty") penalty += Math.abs(e.value);
    else {
      const err = new Error(`unknown flex adjustment type: ${e.type}`);
      err.code = "rules.flex_type_invalid";
      err.params = { type: e.type };
      throw err;
    }
  }
  const net = Math.max(-cfg.max_abs, Math.min(cfg.max_abs, bonus - penalty));
  return { bonus, penalty, net, adjusted: baseTotal + net };
}

/**
 * 等级判定：S 线全市场统一 + S 规模门槛；A/C 线分城；红线按 level_cap 配置封顶（null = 不封）。
 * 传入的 total 应为灵活分调整后的综合分；门槛用原始值判定（加分不能突破规模门槛）。
 * 返回 { level, sScaleGateBlocked, levelBeforeCap }
 */
export function determineLevel(rules, city, total, values, { redline = false } = {}) {
  const lines = { ...rules.level_lines.shared, ...rules.level_lines.by_city[city] };
  if (lines.S === undefined || lines.A === undefined || lines.C === undefined) {
    const err = new Error(`level lines incomplete for city ${city}`);
    err.code = "rules.level_lines_incomplete";
    err.params = { city };
    throw err;
  }
  let level;
  let sScaleGateBlocked = false;
  if (total >= lines.S) {
    const gate = rules.s_scale_gate;
    if (gate?.enabled && !(values[gate.indicator] >= gate.gte)) {
      level = gate.fallback_level;
      sScaleGateBlocked = true;
    } else {
      level = "S";
    }
  } else if (total >= lines.A) {
    level = "A";
  } else if (total < lines.C) {
    level = "C";
  } else {
    level = "B";
  }
  const levelBeforeCap = level;
  const cap = rules.redline?.level_cap;
  if (redline && cap && rankOf(level) < rankOf(cap)) level = cap;
  return { level, sScaleGateBlocked, levelBeforeCap };
}

const LEVEL_ORDER = ["S", "A", "B", "C"];
function rankOf(level) {
  return LEVEL_ORDER.indexOf(level);
}

/**
 * 建议页分支判定（数据驱动，advice_branches 按 priority 升序取第一个命中项）。
 * 目前支持的条件形式：{ all: [{ indicator, score_eq }] }；condition 为 null = 兜底分支。
 */
export function adviceBranch(rules, scores) {
  const branches = [...rules.advice_branches].sort((a, b) => a.priority - b.priority);
  for (const b of branches) {
    if (b.condition == null) return b;
    const conds = b.condition.all ?? [];
    if (conds.every((c) => scores[c.indicator] === c.score_eq)) return b;
  }
  return null;
}

/**
 * 收益预估：金额 = min(完美单数 × 等级单价, 单商月度封顶)。红线命中 → 冻结（金额照算，状态标 frozen）。
 */
export function estimateIncentive(rules, level, perfectOrders, { redline = false } = {}) {
  const rate = rules.incentive.rates[level];
  if (rate === undefined) {
    const err = new Error(`no incentive rate for level ${level}`);
    err.code = "rules.incentive_rate_missing";
    err.params = { level };
    throw err;
  }
  const raw = perfectOrders * rate;
  const cap = rules.incentive.per_vendor_monthly_cap;
  return {
    amount: Math.min(raw, cap),
    capped: raw > cap,
    frozen: redline,
    currency: rules.incentive.currency,
  };
}
