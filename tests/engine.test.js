// 规则引擎边界测试。期望值是 V6 规则的规格断言（测试向量允许字面值；引擎代码不允许）。
// 运行：bun test

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { validateRules, scoreIndicator, scoreComposite, computeScores, determineLevel, adviceBranch, estimateIncentive, applyFlexAdjustment } from "../src/engine/rules.js";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const rules = validateRules(JSON.parse(readFileSync(join(SITE, "data", "rules.json"), "utf-8")));
const ind = (key) => rules.indicators.find((i) => i.key === key);

describe("档位边界（higher_better 用 gte，lower_better 用 lt/lte）", () => {
  test("日均完美单量：1250 整 → 100；1249.9 → 80；A11 后 100 整 → 0（边界归 0 分档）", () => {
    expect(scoreIndicator(ind("orders"), 1250)).toBe(100);
    expect(scoreIndicator(ind("orders"), 1249.9)).toBe(80);
    expect(scoreIndicator(ind("orders"), 500)).toBe(80);
    // A11：第三档改用 gt 100，边界值 100 本身落进 0 分档
    expect(scoreIndicator(ind("orders"), 100.1)).toBe(50);
    expect(scoreIndicator(ind("orders"), 100)).toBe(0);
    expect(scoreIndicator(ind("orders"), 99.9)).toBe(0);
  });
  test("A11：越高越好三项的 0 分档都含边界（gt 算子）", () => {
    // 改回 gte 就会在这里挂——A11 的公示承诺是「边界值一律归 0 分档」
    expect(scoreIndicator(ind("slot"), 40)).toBe(0);
    expect(scoreIndicator(ind("slot"), 40.1)).toBe(50);
    expect(scoreIndicator(ind("slot"), 70)).toBe(80);
    expect(scoreIndicator(ind("newrider"), 30)).toBe(0);
    expect(scoreIndicator(ind("newrider"), 30.1)).toBe(50);
    expect(scoreIndicator(ind("newrider"), 50)).toBe(80);
    // 真实数据里存在拉新率恰为 30.0% 的商 → A11 后该项计 0 分
    expect(scoreIndicator(ind("newrider"), 30.0)).toBe(0);
  });
  test("2R 率（lt 严格小于）：1% 整落到 1–2% 档 → 80；3% 整 → 0", () => {
    expect(scoreIndicator(ind("d3r"), 0.99)).toBe(100);
    expect(scoreIndicator(ind("d3r"), 1)).toBe(80);
    expect(scoreIndicator(ind("d3r"), 3)).toBe(0);
  });
  test("合规账号率：0 → 100；5% 整 → 80；A11 后 15% 整 → 0（边界归 0 分档）", () => {
    expect(scoreIndicator(ind("blocked_rider_rate"), 0)).toBe(100);
    expect(scoreIndicator(ind("blocked_rider_rate"), 5)).toBe(80);
    expect(scoreIndicator(ind("blocked_rider_rate"), 14.9)).toBe(50);
    // A11：第三档 lte 15 → lt 15，15% 整本身落 0 分档
    expect(scoreIndicator(ind("blocked_rider_rate"), 15)).toBe(0);
    expect(scoreIndicator(ind("blocked_rider_rate"), 15.1)).toBe(0);
  });
  test("还款信用：数值输入原样返回（演示数据形态）", () => {
    expect(scoreIndicator(ind("credit"), 76)).toBe(76);
  });
  test("还款信用：CR-20260814 B1 后只剩逾期占比一个分项（坏账不再参与）", () => {
    const credit = ind("credit");
    const comps = credit.composite.components;
    expect(comps.length).toBe(1);
    expect(comps[0].key).toBe("overdue_ratio");
    expect(comps[0].weight).toBe(1.0);
    // A10 收紧后：逾期占比 25% 落「20–50%」档 → 50 分（原 ≤30 档 80 分）。传入的坏账字段被忽略
    expect(scoreComposite(credit, { overdue_ratio: 25, bad_debt_ratio: 99 }).score).toBe(50);
    expect(scoreIndicator(credit, { overdue_ratio: 25 })).toBe(50);
    // A10 档位边界：≤20 → 80；A11 使 50% 整落 0 分档（第三档为 lt 50）
    expect(scoreIndicator(credit, { overdue_ratio: 20 })).toBe(80);
    expect(scoreIndicator(credit, { overdue_ratio: 20.1 })).toBe(50);
    expect(scoreIndicator(credit, { overdue_ratio: 49.9 })).toBe(50);
    expect(scoreIndicator(credit, { overdue_ratio: 50 })).toBe(0);
    // 无欠款 = 满分
    expect(scoreComposite(credit, {}, { noDebt: true })).toBe(credit.composite.no_debt_score);
    expect(scoreIndicator(credit, { no_debt: true })).toBe(credit.composite.no_debt_score);
  });
  test("A10 核心：满分看「逾期占比 = 0」，不是「完全没有欠款」", () => {
    const credit = ind("credit");
    const overdue = credit.composite.components.find((c) => c.key === "overdue_ratio");
    const full = credit.composite.no_debt_score;
    // 满分档门槛必须恰为 0
    expect(overdue.tiers.find((tr) => tr.score === 100).lte).toBe(0);
    // 有欠款但逾期占比为 0（欠款全在账期内）→ 仍满分。7 月有 5 家属此情况，漏了这档会各扣 20 分
    expect(scoreIndicator(credit, { overdue_ratio: 0, bad_debt_ratio: 0 })).toBe(full);
    // 占比只要 >0 就拿不到满分（哪怕很低）
    expect(scoreIndicator(credit, { overdue_ratio: 0.1, bad_debt_ratio: 0 })).toBeLessThan(full);
    // 完全无欠款也是满分
    expect(scoreIndicator(credit, { no_debt: true })).toBe(full);
  });
  test("原始值缺失 → 抛错，不静默给 0", () => {
    expect(() => scoreIndicator(ind("orders"), null)).toThrow();
  });
  test("显式声明 null_value_score 的指标（拉新率分母为 0）→ 按声明计分，不抛错", () => {
    const nr = ind("newrider");
    expect(nr.null_value_score).toBe(0);           // rules.json 里必须显式声明
    expect(scoreIndicator(nr, null)).toBe(0);
    // 未声明的指标仍然严格报错（防止数据缺口伪装成低分）
    expect(ind("slot").null_value_score).toBeUndefined();
    expect(() => scoreIndicator(ind("slot"), null)).toThrow();
  });
});

describe("等级判定（分城线 + S 规模门槛）", () => {
  const linesOf = (city) => ({ ...rules.level_lines.shared, ...rules.level_lines.by_city[city] });
  const gate = rules.s_scale_gate;
  test("CR-20260814 A1：S 规模门槛已停用 → 达 S 线即 S，不再因单量被拦", () => {
    expect(gate.enabled).toBe(false);        // rules.json 里必须是停用状态
    const city = "CDMX";
    const sLine = linesOf(city).S;
    // 单量远低于原门槛，也应授 S，且不打拦截标记
    const low = determineLevel(rules, city, sLine, { [gate.indicator]: 1 });
    expect(low.level).toBe("S");
    expect(low.sScaleGateBlocked).toBe(false);
    // 门槛若日后恢复（enabled:true），引擎应重新拦截——用副本验证机制仍在
    const revived = structuredClone(rules);
    revived.s_scale_gate.enabled = true;
    const blocked = determineLevel(revived, city, sLine, { [gate.indicator]: gate.gte - 1 });
    expect(blocked.level).toBe(gate.fallback_level);
    expect(blocked.sScaleGateBlocked).toBe(true);
  });
  test("A/C 线分城：同一分数在两城可判出不同等级", () => {
    // 取两城 A 线之间的分数（CDMX 65 / MTY 75 → 70 分应为 CDMX=A、MTY=B）
    const mid = (linesOf("CDMX").A + linesOf("MTY").A) / 2;
    expect(determineLevel(rules, "CDMX", mid, {}).level).toBe("A");
    expect(determineLevel(rules, "MTY", mid, {}).level).toBe("B");
  });
  test("线上边界：等于 A 线 → A；等于 C 线 → B（C 是严格小于）", () => {
    for (const city of ["CDMX", "MTY"]) {
      expect(determineLevel(rules, city, linesOf(city).A, {}).level).toBe("A");
      expect(determineLevel(rules, city, linesOf(city).C, {}).level).toBe("B");
      expect(determineLevel(rules, city, linesOf(city).C - 0.1, {}).level).toBe("C");
    }
  });
  test("未知城市 → 抛错，不静默用默认线", () => {
    expect(() => determineLevel(rules, "GDL", 70, {})).toThrow();
  });
});

describe("双 0 分支按得分判定，不按等级", () => {
  test("orders=0 且 slot=0 → double_zero，其余 → default", () => {
    expect(adviceBranch(rules, { orders: 0, slot: 0 }).key).toBe("double_zero");
    expect(adviceBranch(rules, { orders: 0, slot: 50 }).key).toBe("default");
    expect(adviceBranch(rules, { orders: 50, slot: 0 }).key).toBe("default");
  });
});

describe("收益预估封顶", () => {
  const cap = rules.incentive.per_vendor_monthly_cap;
  const sRate = rules.incentive.rates.S;
  test("超过单商月度封顶必须压到封顶值（7 月实例：应发 67 万 → 50 万）", () => {
    const r = estimateIncentive(rules, "S", Math.ceil((cap * 1.34) / sRate));
    expect(r.amount).toBe(cap);
    expect(r.capped).toBe(true);
  });
  test("未超封顶按单价计算；B/C 无现金激励", () => {
    const orders = 1000;
    expect(estimateIncentive(rules, "A", orders).amount).toBe(orders * rules.incentive.rates.A);
    expect(estimateIncentive(rules, "B", orders).amount).toBe(0);
    expect(estimateIncentive(rules, "C", orders).amount).toBe(0);
  });
  test("红线命中 → frozen 标记", () => {
    expect(estimateIncentive(rules, "A", 100, { redline: true }).frozen).toBe(true);
  });
});

describe("灵活分（加/扣分开、净值封顶、硬约束不被突破）", () => {
  const maxAbs = rules.flex_adjustment.max_abs;
  test("加分与扣分分别汇总，净值 = 加 − 扣", () => {
    const r = applyFlexAdjustment(rules, 70, [
      { value: 5, type: "activity_bonus", reason_key: "x" },
      { value: -3, type: "penalty", reason_key: "y" },
    ]);
    expect(r.bonus).toBe(5);
    expect(r.penalty).toBe(3);
    expect(r.net).toBe(2);
    expect(r.adjusted).toBe(72);
  });
  test("净值夹在 ±max_abs 内", () => {
    const over = applyFlexAdjustment(rules, 70, [{ value: maxAbs * 3, type: "activity_bonus" }]);
    expect(over.net).toBe(maxAbs);
    const under = applyFlexAdjustment(rules, 70, [{ value: maxAbs * 3, type: "penalty" }]);
    expect(under.net).toBe(-maxAbs);
  });
  test("无条目 → 全零，不改综合分", () => {
    const r = applyFlexAdjustment(rules, 70, []);
    expect(r.net).toBe(0);
    expect(r.adjusted).toBe(70);
  });
  test("未知类型 → 抛错，不静默", () => {
    expect(() => applyFlexAdjustment(rules, 70, [{ value: 5, type: "mystery" }])).toThrow();
  });
  test("加分推过 S 线 → 授 S（门槛已停用）；门槛恢复时仍是硬约束", () => {
    const gate = rules.s_scale_gate;
    const lines = { ...rules.level_lines.shared, ...rules.level_lines.by_city.CDMX };
    const base = lines.S - 2;
    const flex = applyFlexAdjustment(rules, base, [{ value: 5, type: "activity_bonus" }]);
    expect(flex.adjusted).toBeGreaterThanOrEqual(lines.S);
    // 门槛停用 → 加分推过线就是 S
    expect(determineLevel(rules, "CDMX", flex.adjusted, { [gate.indicator]: 1 }).level).toBe("S");
    // 门槛恢复 → 加分不能突破（机制仍在，见 A1 保留字段的理由）
    const revived = structuredClone(rules);
    revived.s_scale_gate.enabled = true;
    const blocked = determineLevel(revived, "CDMX", flex.adjusted, { [gate.indicator]: gate.gte - 1 });
    expect(blocked.level).toBe(gate.fallback_level);
    expect(blocked.sScaleGateBlocked).toBe(true);
  });
  test("红线封顶在灵活分之后仍生效（最终硬约束）", () => {
    const lines = { ...rules.level_lines.shared, ...rules.level_lines.by_city.CDMX };
    const flex = applyFlexAdjustment(rules, lines.A - 1, [{ value: 5, type: "activity_bonus" }]);
    const capped = determineLevel(rules, "CDMX", flex.adjusted, {}, { redline: true });
    expect(capped.level).toBe(rules.redline.level_cap);
  });
});

describe("规则加载校验", () => {
  test("权重和 ≠ 1.0 → 拒绝并带 code", () => {
    const bad = structuredClone(rules);
    bad.indicators[0].weight += 0.05;
    let caught;
    try { validateRules(bad); } catch (e) { caught = e; }
    expect(caught?.code).toBe("rules.weight_sum_invalid");
  });
  test("computeScores 综合分 = Σ(得分×权重)", () => {
    const values = { orders: 3086, slot: 93.3, credit: 100, d3r: 0.62, newrider: 25, blocked_rider_rate: 0 };
    const { total, scores } = computeScores(rules, values);
    const expected = rules.indicators.reduce((a, i) => a + scores[i.key] * i.weight, 0);
    expect(total).toBeCloseTo(expected, 10);
  });
});
