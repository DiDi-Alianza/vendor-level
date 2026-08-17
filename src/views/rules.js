// 规则公示页（需求文档 6.1 / 11 硬性要求 5）：完全由 rules.json 渲染，不手写任何表格数值。
// 本文件不含权重/阈值/分数线/单价字面值；文案模板在 i18n，数值一律作为参数注入。

import { t, fmtNumber, fmtCurrency, fmtMonth, tUnit } from "../i18n.js";
import { isCompositeInput, tierThreshold } from "../engine/rules.js";

const pct = (w) => `${fmtNumber(w * 100, { maximumFractionDigits: 0 })}%`;

/**
 * 复合分公式文案：**按 components 实际个数生成**，不假设有两项。
 * CR-20260814 B1 把坏账分项删掉后 components 只剩一项，写死 components[1] 会崩（2026-08-14 踩过）。
 */
function creditFormula(credit) {
  const comps = credit.composite.components;
  const noDebt = fmtNumber(credit.composite.no_debt_score);
  if (comps.length === 1) return t("rules.credit.formula", { noDebt });
  return t("rules.credit.formula_multi", {
    noDebt,
    parts: comps.map((c) => t("rules.credit.part", {
      name: t(`rules.credit.${c.key}`), w: fmtNumber(c.weight * 100),
    })).join(t("common.plus")),
  });
}

/** 档位区间文案：按 direction 与 tiers 结构生成（通用，不看指标 key） */
function tierRangeLabels(rule) {
  if (rule.direction === "higher_better") {
    const desc = [...rule.tiers].sort((a, b) => tierThreshold(b) - tierThreshold(a));
    return desc.map((tier, i) => {
      if (i === 0) return t("tier.gte", { v: fmtNumber(tierThreshold(tier)) });
      const prev = desc[i - 1];
      const prevV = fmtNumber(tierThreshold(prev));
      // 末档（0 分档）的边界归属：上一档用 gt → 边界值属于本档，写 ≤；用 gte → 写 <
      if (i === desc.length - 1) return t("gt" in prev ? "tier.lte" : "tier.lt", { v: prevV });
      // 区间一律写「下界 – 上界」，与官宣材料《Level System Upgrade》第二节的写法一致。
      // 边界归属不靠这里区分——末档已写成「≤ 下界」（A11：边界值归 0 分档），读表时以末档为准。
      return t("tier.range", { a: fmtNumber(tierThreshold(tier)), b: prevV });
    });
  }
  const tiers = rule.tiers;
  return tiers.map((tier, i) => {
    // 档位可自带文案（如信用满分档官宣写「无逾期」而不是「0」）
    if (tier.label_key) return t(tier.label_key);
    const kind = "lt" in tier ? "lt" : "lte";
    const v = tier[kind];
    const prev = i > 0 ? tiers[i - 1] : null;
    const prevV = prev ? prev["lt" in prev ? "lt" : "lte"] : null;
    // 兜底档（阈值 null）的边界归属由**上一档**的算子决定：
    // 上一档 lt X → 本档从 X 起（含），写 ≥X；上一档 lte X → 本档从 X 之后起，写 >X。
    // 看本档自己的算子是错的：A11 之后信用的兜底档是 lte:null、上一档是 lt:50，正确文案是「≥50」。
    if (v === null) {
      return prev && "lt" in prev
        ? t("tier.gte", { v: fmtNumber(prevV) })
        : t("tier.gt", { v: fmtNumber(prevV) });
    }
    if (i === 0) {
      if (kind === "lte" && v === 0) return t("tier.zero");
      return t(`tier.${kind}`, { v: fmtNumber(v) });
    }
    // 上一档就是 0（如信用「无逾期」、合规账号率「0」）→ 本档写 ≤v，不写「0 – v」
    if (prevV === 0) return t(`tier.${kind}`, { v: fmtNumber(v) });
    return t("tier.range", { a: fmtNumber(prevV), b: fmtNumber(v) });
  });
}

function indicatorsSection(rules) {
  const rows = rules.indicators.map((rule) => {
    // 复合指标（还款信用）按其唯一分项的档位展示——与官宣材料《Level System Upgrade》第二节一致。
    // 计分方法不再单独成节，档位就是这一行，不能再用公式占位。
    const shown = isCompositeInput(rule) ? rule.composite.components[0] : rule;
    const labels = tierRangeLabels(shown);
    const cells = labels.map((l) => `<td class="n">${l}</td>`).join("");
    return `
    <tr>
      <td>
        <span class="fw">${t(`indicator.${rule.key}`)}</span>
        <div class="faint">${t(`indicator.${rule.key}.desc`)}${
          rule.proxy_notice_key ? `<br>${t(rule.proxy_notice_key)}` : ""}</div>
        <div class="faint">${t("rules.h.unit", { unit: tUnit(shown) })} · ${t(`direction.${shown.direction}`)}</div>
      </td>
      <td class="n fw">${pct(rule.weight)}</td>
      ${cells}
    </tr>`;
  }).join("");

  return `
  <section class="section">
    <h2>${t("rules.section.indicators")}</h2>
    <div class="card">
      <p class="muted small" style="margin-bottom:14px">${t("rules.total_formula")}</p>
      <div class="table-scroll"><table class="rules-indicators">
        <colgroup>
          <col class="c-ind"><col class="c-w">
          <col class="c-t"><col class="c-t"><col class="c-t"><col class="c-t">
        </colgroup>
        <thead><tr>
          <th>${t("rules.h.indicator")}</th><th class="n">${t("rules.h.weight")}</th>
          <th class="n">${t("rules.h.tier100")}</th><th class="n">${t("rules.h.tier80")}</th>
          <th class="n">${t("rules.h.tier50")}</th><th class="n">${t("rules.h.tier0")}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
  </section>`;
}

// 【已下线 2026-08-16】还款信用的计分方法不再单独成节——档位已在指标表里写全，重复展示反而让商家以为是两套算法。
// 函数保留，恢复只需在 renderRules 里加回一行。
function creditSection(rules) {
  const credit = rules.indicators.find(isCompositeInput);
  if (!credit) return "";
  const comps = credit.composite.components;
  const tables = comps.map((c) => {
    const labels = tierRangeLabels(c);
    const rows = c.tiers.map((tier, i) =>
      `<tr><td>${labels[i]}%</td><td class="n">${fmtNumber(tier.score)}</td></tr>`).join("");
    return `
    <div style="flex:1;min-width:240px">
      <p class="fw small" style="margin-bottom:8px">${t(`rules.credit.${c.key}`)} · ${pct(c.weight)}</p>
      <table><thead><tr><th>${t("rules.h.condition")}</th><th class="n">${t("rules.h.score")}</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;
  }).join("");

  return `
  <section class="section">
    <h2>${t("rules.section.credit")}</h2>
    <div class="card">
      <p class="muted small" style="margin-bottom:16px">${creditFormula(credit)}</p>
      <div style="display:flex;gap:32px;flex-wrap:wrap">${tables}</div>
      <p class="faint" style="margin-top:14px">${t("rules.credit.appeal")}</p>
    </div>
  </section>`;
}

function levelsSection(rules, { city, seeAllCities }) {
  const gate = rules.s_scale_gate;
  const shared = rules.level_lines.shared;
  // 数据隔离：Vendor 只看自己城市的分数线；RM 及以上看全部（2026-08-14 用户要求）
  const allCities = Object.entries(rules.level_lines.by_city);
  const cities = seeAllCities ? allCities : allCities.filter(([c]) => c === city);
  // S 线两种结构都支持：shared.S（全市场统一）或 by_city[城市].S（分城，CR-20260814 后）
  const sIsShared = shared?.S !== undefined;
  const sCell = (l) => {
    const line = sIsShared ? shared.S : l.S;
    return gate?.enabled
      ? t("rules.levels.s", {
          sline: fmtNumber(line),
          indicator: t(`indicator.${gate.indicator}`),
          gate: fmtNumber(gate.gte),
        })
      : t("rules.levels.s_no_gate", { line: fmtNumber(line) });   // 门槛停用 → S 只看本城分数线
  };
  const row = (label, fn) =>
    `<tr><td class="fw">${label}</td>${cities.map(([, l]) => `<td>${fn(l)}</td>`).join("")}</tr>`;
  return `
  <section class="section">
    <h2>${t("rules.section.levels")}</h2>
    <div class="card">
      <div class="table-scroll"><table>
        <thead><tr><th>${t("rules.h.level")}</th>${cities.map(([c]) => `<th>${c}</th>`).join("")}</tr></thead>
        <tbody>
          ${sIsShared
             ? `<tr><td class="fw">S</td><td colspan="${cities.length}">${sCell(cities[0]?.[1] ?? {})}</td></tr>`
             : row("S", (l) => sCell(l))}
          ${row("A", (l) => t("rules.levels.a", { line: fmtNumber(l.A) }))}
          ${row("B", (l) => t("rules.levels.b", { c: fmtNumber(l.C), a: fmtNumber(l.A) }))}
          ${row("C", (l) => t("rules.levels.c", { line: fmtNumber(l.C) }))}
        </tbody>
      </table></div>
      <p class="faint" style="margin-top:14px">${
        seeAllCities ? t("rules.city_scope_all") : t("rules.city_scope", { city })}</p>
      <p class="faint" style="margin-top:6px">${t("rules.levels.note")}</p>
    </div>
  </section>`;
}

/** 直接评定 C 级的情形（诚信合规类，与欠款红线是两套机制） */
function directCSection(rules) {
  const d = rules.direct_c_conditions;
  if (!d) return "";
  return `
  <section class="section">
    <h2>${t("rules.section.direct_c")}</h2>
    <div class="card">
      <p class="fw">${t("rules.direct_c.intro")}</p>
      <ol style="padding-left:22px;margin-top:12px" class="muted">
        ${d.conditions.map((c) => `<li style="margin-bottom:6px">${t(c.text_key)}</li>`).join("")}
      </ol>
      <p class="faint" style="margin-top:12px">${t("rules.direct_c.vs_redline")}</p>
    </div>
  </section>`;
}

function flexSection(rules) {
  const f = rules.flex_adjustment;
  if (!f) return "";
  const prohibited = f.components?.penalty?.no_double_penalty?.prohibited ?? [];
  const rows = prohibited.map((p) => `
    <tr><td>${p.behavior_key ? t(p.behavior_key) : p.behavior}</td><td class="muted">${
      t("rules.flex.prohibited_covered", {
        covered: p.covered_by_key ? t(p.covered_by_key) : p.covered_by })}</td></tr>`).join("");
  return `
  <section class="section">
    <h2>${t("rules.section.flex")}</h2>
    <div class="card">
      <p class="fw">${t("rules.flex.note", { n: fmtNumber(f.max_abs) })}</p>
      <p style="margin-top:10px">${t("flex.activity.note")}</p>
      <p style="margin-top:8px">${t("flex.penalty.note")}</p>
      <p class="faint" style="margin-top:10px">${t("rules.flex.order", {
        indicator: t(`indicator.${rules.s_scale_gate.indicator}`),
        gate: fmtNumber(rules.s_scale_gate.gte),
      })}</p>
      <p class="fw small" style="margin-top:16px;margin-bottom:8px">${t("rules.flex.no_double_title")}</p>
      <p class="muted small" style="margin-bottom:8px">${t("rules.flex.no_double_body")}</p>
      ${rows ? `<div class="table-scroll"><table><tbody>${rows}</tbody></table></div>` : ""}
    </div>
  </section>`;
}

function redlineSection(rules) {
  const r = rules.redline;
  return `
  <section class="section">
    <h2>${t("rules.section.redline")}</h2>
    <div class="card">
      <p>${t("rules.redline.weekly", {
        amount: fmtCurrency(r.weekly_hit.overdue_7d_amount_gte, rules.incentive.currency),
        ratio: fmtNumber(r.weekly_hit.overdue_ratio_gte),
      })}</p>
      <p style="margin-top:8px">${t("rules.redline.trigger", { hits: fmtNumber(r.trigger.monthly_hits_gte) })}</p>
      <p class="fw" style="margin-top:8px">${t("rules.redline.action")}</p>
      ${r.level_cap ? `<p class="fw" style="margin-top:8px">${t("rules.redline.level_cap", { level: r.level_cap })}</p>` : ""}
      <p class="faint" style="margin-top:8px">${t("rules.redline.relation")}</p>
      <p class="faint" style="margin-top:8px">${t("rules.redline.warning", {
        weeks: fmtNumber(r.warning.or.find((c) => c.redline_weeks_gte)?.redline_weeks_gte ?? 0),
      })}</p>
    </div>
  </section>`;
}

function incentiveSection(rules) {
  const inc = rules.incentive;
  return `
  <section class="section">
    <h2>${t("rules.section.incentive")}</h2>
    <div class="card">
      <p class="fw">${t("rules.incentive.rate_s", { rate: fmtCurrency(inc.rates.S, inc.currency) })} ·
         ${t("rules.incentive.rate_a", { rate: fmtCurrency(inc.rates.A, inc.currency) })}</p>
      <p class="muted" style="margin-top:6px">${t("rules.incentive.rate_none")}</p>
      <p style="margin-top:8px">${t("rules.incentive.cap", { cap: fmtCurrency(inc.per_vendor_monthly_cap, inc.currency) })}</p>
      <p class="faint" style="margin-top:8px">${t("rules.incentive.basis")} ${t("rules.incentive.redline_note")}</p>
    </div>
  </section>`;
}

function protectionSection(rules) {
  const p = rules.new_vendor_protection;
  const cutoff = p.counting_start_rule.cutoff_day;
  const exampleRows = (p.examples ?? []).map((ex) => `
    <tr>
      <td class="n">${ex.first_order}</td>
      <td class="n">${ex.counting_start}</td>
      <td class="n">${ex.exempt_months.join(" / ")}</td>
      <td class="n">${ex.clearance_counts_from}</td>
    </tr>`).join("");
  return `
  <section class="section">
    <h2>${t("rules.section.protection")}</h2>
    <div class="card">
      <p>${t("rules.protection.exempt", { months: fmtNumber(p.exempt_months) })}</p>
      <p style="margin-top:8px">${t("rules.protection.counted", { month: fmtNumber(p.exempt_months + 1) })}</p>
      <p style="margin-top:8px">${t("rules.protection.cutoff", { day: fmtNumber(cutoff) })}</p>
      <p class="fw" style="margin-top:8px">${t("rules.protection.redline_exception")}</p>
      <p class="muted" style="margin-top:8px">${t("rules.protection.no_ceiling")}</p>
      <p class="fw small" style="margin-top:18px;margin-bottom:8px">${t("rules.protection.examples_title")}</p>
      <div class="table-scroll"><table>
        <thead><tr>
          <th class="n">${t("rules.h.first_order")}</th><th class="n">${t("rules.h.counting_start")}</th>
          <th class="n">${t("rules.h.exempt_months")}</th><th class="n">${t("rules.h.clearance_from")}</th>
        </tr></thead>
        <tbody>${exampleRows}</tbody>
      </table></div>
    </div>
  </section>`;
}

function clearanceSection(rules) {
  return `
  <section class="section">
    <h2>${t("rules.section.clearance")}</h2>
    <div class="card">
      <p>${t("rules.clearance.body", {
        start: fmtNumber(rules.new_vendor_protection.exempt_months + 1),
        months: fmtNumber(rules.clearance.consecutive_c_months),
      })}</p>
    </div>
  </section>`;
}

function benefitsSection(rules) {
  const inc = rules.incentive;
  const block = (titleKey, items) => `
    <div class="card">
      <h3 class="fw" style="margin-bottom:10px">${t(titleKey)}</h3>
      <ul style="padding-left:20px" class="muted">${items.map((i) => `<li>${i}</li>`).join("")}</ul>
    </div>`;
  return `
  <section class="section">
    <h2>${t("rules.section.benefits")}</h2>
    <p class="faint small" style="margin-bottom:12px">${t("rules.benefits.note")}</p>
    ${block("rules.benefits.cash.title", [
      t("rules.benefits.cash.b1", {
        sRate: fmtCurrency(inc.rates.S, inc.currency),
        aRate: fmtCurrency(inc.rates.A, inc.currency),
      }),
      t("rules.benefits.cash.b2", { cap: fmtCurrency(inc.per_vendor_monthly_cap, inc.currency) }),
      t("rules.benefits.cash.b3"),
    ])}
    ${block("rules.benefits.growth.title", [
      t("rules.benefits.growth.b1"), t("rules.benefits.growth.b2"),
      t("rules.benefits.growth.b3"), t("rules.benefits.growth.b4"),
    ])}
    ${block("rules.benefits.honor.title", [t("rules.benefits.honor.b1"), t("rules.benefits.honor.b2")])}
    ${block("rules.benefits.gear.title", [t("rules.benefits.gear.b1"), t("rules.benefits.gear.b2")])}
  </section>`;
}

// 【已下线 2026-08-16】规则更新记录不对外展示——对商官宣的规则目前只有一版，页面上列内部迭代会让商家以为规则一直在变。
// changelog 数据仍留在 rules.json（validate_rules 依赖它校验「声称改了是否真改了」），只是不渲染。
function changelogSection(rules) {
  // 条目既支持 i18n 键（内置版本）也支持编辑器写入的字面文本（*_text 字段）
  const rows = [...rules.changelog].reverse().map((c) => `
    <tr>
      <td class="fw">${c.version}</td>
      <td class="n">${fmtMonth(c.effective_from)}</td>
      <td>${c.summary_key ? t(c.summary_key) : (c.summary_text ?? "")}<ul style="padding-left:18px" class="faint">${
        (c.changes_keys?.map((k) => t(k)) ?? c.changes_texts ?? []).map((x) => `<li>${x}</li>`).join("")}</ul></td>
      <td class="muted">${c.reason_key ? t(c.reason_key) : (c.reason_text ?? "")}</td>
    </tr>`).join("");
  return `
  <section class="section">
    <h2>${t("rules.section.changelog")}</h2>
    <div class="card">
      <div class="table-scroll"><table>
        <thead><tr>
          <th>${t("rules.h.version")}</th><th class="n">${t("rules.h.effective")}</th>
          <th>${t("rules.h.changes")}</th><th>${t("rules.h.reason")}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
  </section>`;
}

export function renderRules({ rules, viewer }) {
  return `
  <section class="section">
    <h2 class="page-title">${t("rules.title")}</h2>
    <p class="faint">${t("rules.subtitle", { version: rules.version })}</p>
  </section>
  ${indicatorsSection(rules)}
  ${levelsSection(rules, viewer)}
  ${flexSection(rules)}
  ${redlineSection(rules)}
  ${incentiveSection(rules)}
  ${protectionSection(rules)}
  ${clearanceSection(rules)}
  ${directCSection(rules)}
  ${benefitsSection(rules)}`;
}
