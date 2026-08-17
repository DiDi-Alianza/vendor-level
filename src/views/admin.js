// 管理后台（需求文档 6.7 / 11.1 规则编辑器 / 11.2 分数线沙盘）。
// 保存流程（不可简化）：改 → 校验 → 强制试算 → 变更原因必填 → POST /api/rules（服务端先备份再写入）→ 全站重载。
// 校验错误一律人话（i18n），不抛 JSON 异常。演示阶段无鉴权，见 admin.demo_note。

import { t, fmtNumber, fmtCurrency, fmtPoints, tUnit } from "../i18n.js";
// 规则可写与否取决于数据源：本地演示有 /api/* 后端；线上静态托管没有，且规则不许从页面写库
import { SOURCE } from "../data.js";
const RULES_WRITABLE = SOURCE === "local";
import { computeScores, determineLevel, estimateIncentive, activeIndicators, isCompositeInput, applyFlexAdjustment } from "../engine/rules.js";
import { protectionStatus } from "../engine/protection.js";
import { badgeSmall } from "../components/badge.js";

let activeTab = "editor";
let draft = null;        // 编辑器工作副本
let simDone = false;     // 强制试算门
let lastSimHTML = "";
let flashMsg = "";
let sandboxLines = null; // 沙盘工作副本（只试不存）

const setPath = (obj, path, value) => {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = cur[p];
  cur[parts[parts.length - 1]] = value;
};

// A11 起 higher_better 可能用 gt（严格大于），lower_better 可能用 lt——四种算子都要认
const thresholdKey = (tier) =>
  "gte" in tier ? "gte" : "gt" in tier ? "gt" : "lt" in tier ? "lt" : "lte";

/** 编辑器不可停用的指标：被 S 门槛或建议分支引用 */
function referencedKeys(rules) {
  const keys = new Set([rules.s_scale_gate.indicator]);
  for (const b of rules.advice_branches) {
    for (const c of b.condition?.all ?? []) keys.add(c.indicator);
    for (const k of b.focus_indicators ?? []) keys.add(k);
  }
  return keys;
}

/* ---------------- 校验（返回翻译好的人话列表） ---------------- */
function validateDraft(d) {
  const errs = [];
  const active = d.indicators.filter((i) => i.enabled !== false);
  const sum = active.reduce((a, i) => a + i.weight, 0) * 100;
  if (Math.abs(sum - 100) > 1e-6) {
    errs.push(t("admin.editor.weight_sum_bad", {
      sum: fmtNumber(sum, { maximumFractionDigits: 1 }),
      diff: fmtNumber(100 - sum, { maximumFractionDigits: 1 }),
    }));
  }
  const refs = referencedKeys(d);
  const checkTiers = (name, direction, tiers) => {
    let prevT = null, prevS = null;
    tiers.forEach((tier, i) => {
      const v = tier[thresholdKey(tier)];
      if (v !== null) {
        if (Number.isNaN(v)) errs.push(t("admin.check.tiers_monotonic", { name, i: i + 1 }));
        if (prevT !== null && ((direction === "higher_better" && v >= prevT) ||
                               (direction === "lower_better" && v <= prevT))) {
          errs.push(t("admin.check.tiers_monotonic", { name, i: i + 1 }));
        }
        prevT = v;
      }
      if (prevS !== null && tier.score >= prevS) {
        errs.push(t("admin.check.scores_monotonic", { name, i: i + 1 }));
      }
      prevS = tier.score;
    });
  };
  for (const ind of d.indicators) {
    if (ind.enabled === false && refs.has(ind.key)) {
      errs.push(t("admin.check.disable_referenced", { name: t(`indicator.${ind.key}`) }));
    }
    const name = t(`indicator.${ind.key}`);
    if (isCompositeInput(ind)) {
      // 复合分已解锁：逐分项校验档位（2026-08-13）
      for (const c of ind.composite.components) {
        checkTiers(`${name} · ${t(`rules.credit.${c.key}`)}`, c.direction, c.tiers);
      }
      continue;
    }
    checkTiers(name, ind.direction, ind.tiers);
  }
  // S 线兼容两种结构：by_city[城市].S（CR-20260814 起分城）或 shared.S（旧结构）
  for (const [city, l] of Object.entries(d.level_lines.by_city)) {
    const s = l.S ?? d.level_lines.shared?.S;
    if (s === undefined || !(l.C < l.A && l.A < s)) {
      errs.push(t("admin.check.lines_order", { city, c: l.C, a: l.A, s: s ?? "—" }));
    }
  }
  const rl = d.redline;
  if (!(rl.weekly_hit.overdue_7d_amount_gte > 0)) errs.push(t("admin.check.positive", { field: t("admin.editor.rl_amount", { currency: d.incentive.currency }) }));
  if (!(rl.weekly_hit.overdue_ratio_gte >= 0 && rl.weekly_hit.overdue_ratio_gte <= 100)) errs.push(t("admin.check.range_0_100", { field: t("admin.editor.rl_ratio") }));
  if (!(rl.trigger.monthly_hits_gte >= 1)) errs.push(t("admin.check.positive", { field: t("admin.editor.rl_hits") }));
  if (!(d.incentive.per_vendor_monthly_cap > 0)) errs.push(t("admin.check.positive", { field: t("admin.editor.cap", { currency: d.incentive.currency }) }));
  if (!(d.new_vendor_protection.exempt_months >= 1)) errs.push(t("admin.check.positive", { field: t("admin.editor.exempt_months") }));
  const cd = d.new_vendor_protection.counting_start_rule.cutoff_day;
  if (!(cd >= 1 && cd <= 28)) errs.push(t("admin.check.cutoff_range"));
  if (!(d.clearance.consecutive_c_months >= 1)) errs.push(t("admin.check.positive", { field: t("admin.editor.consecutive_c") }));
  return errs;
}

/* ---------------- 试算（改动前后对比） ---------------- */
function payout(rules, level, monthly, redline) {
  const est = estimateIncentive(rules, level, monthly, { redline });
  return est.frozen ? 0 : est.amount;
}

function simulate(oldRules, newRules, vendorsData, period) {
  const days = period.days;
  const gateKey = oldRules.s_scale_gate.indicator;
  const cities = {};
  const affected = [];
  let oldCost = 0, newCost = 0;
  for (const v of vendorsData.vendors) {
    const values = Object.fromEntries(v.indicators.map((i) => [i.key, i.value]));
    const monthly = values[gateKey] * days;
    const oldLevel = v.level; // 基线 = 数据快照（与引擎已核对一致）
    const { total } = computeScores(newRules, values);
    const flex = applyFlexAdjustment(newRules, total, v.flex_adjustments ?? []);
    const { level: newLevel } = determineLevel(newRules, v.city, flex.adjusted, values, { redline: v.redline });
    oldCost += payout(oldRules, oldLevel, monthly, v.redline);
    newCost += payout(newRules, newLevel, monthly, v.redline);
    const c = (cities[v.city] ??= { old: { S: 0, A: 0, B: 0, C: 0 }, new: { S: 0, A: 0, B: 0, C: 0 } });
    c.old[oldLevel]++; c.new[newLevel]++;
    if (oldLevel !== newLevel) affected.push({ code: v.vendor_code, city: v.city, from: oldLevel, to: newLevel });
  }
  return { cities, affected, oldCost, newCost };
}

function simHTML(sim, currency) {
  const dist = (d) => `${d.S} / ${d.A} / ${d.B} / ${d.C}`;
  const sa = (d) => {
    const n = d.S + d.A + d.B + d.C;
    return `${fmtNumber(((d.S + d.A) / n) * 100, { maximumFractionDigits: 1 })}%`;
  };
  const rows = Object.entries(sim.cities).map(([city, c]) => `
    <tr><td class="fw">${city}</td>
      <td class="n num">${dist(c.old)} → <b>${dist(c.new)}</b></td>
      <td class="n num">${sa(c.old)} → <b>${sa(c.new)}</b></td></tr>`).join("");
  const affectedList = sim.affected.length
    ? `<p class="small muted" style="margin-top:10px">${t("admin.sim.affected", { n: fmtNumber(sim.affected.length) })}${t("common.colon")}${
        sim.affected.map((a) => `<span class="num">${a.code}${t("common.paren_open")}${a.from}${t("common.arrow")}${a.to}${t("common.paren_close")}</span>`).join(t("common.list_sep"))}</p>`
    : `<p class="small muted" style="margin-top:10px">${t("admin.sim.affected_none")}</p>`;
  return `
  <div class="card" style="margin-top:18px">
    <h3 class="fw" style="margin-bottom:12px">${t("admin.sim.title")}</h3>
    <div class="table-scroll"><table>
      <thead><tr><th>${t("admin.sim.city")}</th><th class="n">${t("admin.sim.dist")}</th><th class="n">${t("admin.sim.sa")}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="num" style="margin-top:12px">${t("admin.sim.cost")}${t("common.colon")}${fmtCurrency(sim.oldCost, currency)} → <b>${fmtCurrency(sim.newCost, currency)}</b></p>
    ${affectedList}
    <p class="faint small" style="margin-top:8px">${t("admin.sim.cost_note")}</p>
  </div>`;
}

/* ---------------- 改动摘要（进 changelog.changes_texts） ---------------- */
function diffLines(oldR, newR) {
  const lines = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (oldR.level_lines.shared?.S !== newR.level_lines.shared?.S) {
    lines.push(t("admin.diff.s_shared", {
      from: oldR.level_lines.shared?.S ?? "—", to: newR.level_lines.shared?.S ?? "—" }));
  }
  for (const city of Object.keys(oldR.level_lines.by_city)) {
    for (const k of ["S", "A", "C"]) {   // S 自 CR-20260814 起分城，一并纳入 diff
      const o = oldR.level_lines.by_city[city][k], n = newR.level_lines.by_city[city][k];
      if (o !== n) lines.push(t("admin.diff.city_line", { city, line: k, from: o, to: n }));
    }
  }
  oldR.indicators.forEach((oi, i) => {
    const ni = newR.indicators[i];
    const name = t(`indicator.${oi.key}`);
    if (oi.weight !== ni.weight) {
      lines.push(t("admin.diff.weight", { name, from: oi.weight * 100, to: ni.weight * 100 }));
    }
    if ((oi.enabled !== false) !== (ni.enabled !== false)) {
      lines.push(t(ni.enabled === false ? "admin.diff.disabled" : "admin.diff.enabled", { name }));
    }
    const tierDiff = (label, oldTiers, newTiers) => {
      oldTiers.forEach((ot, j) => {
        const nt = newTiers[j];
        const k = thresholdKey(ot);
        if (ot[k] !== nt[k]) {
          lines.push(t("admin.diff.tier_threshold", { label, i: j + 1, from: ot[k], to: nt[k] }));
        }
        if (ot.score !== nt.score) {
          lines.push(t("admin.diff.tier_score", { label, i: j + 1, from: ot.score, to: nt.score }));
        }
      });
    };
    if (isCompositeInput(oi)) {
      oi.composite.components.forEach((oc, ci) => {
        const nc = ni.composite.components[ci];
        if (!eq(oc.tiers, nc.tiers)) tierDiff(`${name} · ${t(`rules.credit.${oc.key}`)}`, oc.tiers, nc.tiers);
      });
    } else if (!eq(oi.tiers, ni.tiers)) {
      tierDiff(name, oi.tiers, ni.tiers);
    }
  });
  for (const lv of ["S", "A"]) {
    if (oldR.incentive.rates[lv] !== newR.incentive.rates[lv]) {
      lines.push(t("admin.diff.rate", { level: lv, from: oldR.incentive.rates[lv], to: newR.incentive.rates[lv] }));
    }
  }
  if (oldR.incentive.per_vendor_monthly_cap !== newR.incentive.per_vendor_monthly_cap) {
    lines.push(t("admin.diff.cap", {
      from: oldR.incentive.per_vendor_monthly_cap, to: newR.incentive.per_vendor_monthly_cap }));
  }
  const pairs = [
    ["redline.weekly_hit.overdue_7d_amount_gte", "admin.field.rl_amount"],
    ["redline.weekly_hit.overdue_ratio_gte", "admin.field.rl_ratio"],
    ["redline.trigger.monthly_hits_gte", "admin.field.rl_hits"],
    ["redline.level_cap", "admin.field.rl_cap"],
    ["new_vendor_protection.exempt_months", "admin.field.exempt_months"],
    ["new_vendor_protection.counting_start_rule.cutoff_day", "admin.field.cutoff_day"],
    ["clearance.consecutive_c_months", "admin.field.consecutive_c"],
  ];
  const get = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
  for (const [p, labelKey] of pairs) {
    const o = get(oldR, p), n = get(newR, p);
    if (!eq(o, n)) {
      lines.push(t("admin.diff.generic", {
        label: t(labelKey), from: o ?? t("common.none"), to: n ?? t("common.none") }));
    }
  }
  return lines;
}

/* ---------------- 编辑器 ---------------- */
function numField(labelText, path, value, { step = 1, scale = 1 } = {}) {
  return `
  <label class="field">
    <span class="faint small">${labelText}</span>
    <input type="number" step="${step}" value="${scale === 1 ? value : value * scale}"
           data-path="${path}" data-scale="${scale}">
  </label>`;
}

function editorHTML(rules) {
  const d = draft;
  const currency = d.incentive.currency;
  const errs = validateDraft(d);
  const sum = d.indicators.filter((i) => i.enabled !== false).reduce((a, i) => a + i.weight, 0) * 100;

  const linesBlock = `
  <div class="card">
    <h3 class="fw" style="margin-bottom:14px">${t("admin.editor.lines")}</h3>
    <div class="form-grid">
      ${d.level_lines.shared?.S !== undefined
        ? numField(t("admin.editor.s_shared"), "level_lines.shared.S", d.level_lines.shared.S)
        : ""}
      ${Object.entries(d.level_lines.by_city).map(([city, l]) =>
        // S 线自 CR-20260814 起分城；旧结构（shared.S）仍兼容，见上一行
        (l.S !== undefined ? numField(t("admin.editor.s_line", { city }), `level_lines.by_city.${city}.S`, l.S) : "") +
        numField(t("admin.editor.a_line", { city }), `level_lines.by_city.${city}.A`, l.A) +
        numField(t("admin.editor.c_line", { city }), `level_lines.by_city.${city}.C`, l.C)).join("")}
    </div>
  </div>`;

  const refs = referencedKeys(d);
  const weightsBlock = `
  <div class="card">
    <h3 class="fw" style="margin-bottom:6px">${t("admin.editor.weights")}</h3>
    <p class="small ${Math.abs(sum - 100) > 1e-6 ? "err-text" : "muted"}" id="weight-sum">${
      t("admin.editor.weight_sum", { sum: fmtNumber(sum, { maximumFractionDigits: 1 }) })}</p>
    <div class="form-grid" style="margin-top:10px">
      ${d.indicators.map((ind, i) => `
      <label class="field">
        <span class="faint small">${t(`indicator.${ind.key}`)}${t("common.paren_open")}%${t("common.paren_close")}
          ${refs.has(ind.key) ? "" : `<label class="small" style="margin-left:6px">
            <input type="checkbox" data-enabled-index="${i}" ${ind.enabled !== false ? "checked" : ""}> ${t("admin.editor.enabled")}</label>`}
        </span>
        <input type="number" step="1" min="0" max="100" value="${ind.weight * 100}"
               data-path="indicators.${i}.weight" data-scale="100" ${ind.enabled === false ? "disabled" : ""}>
      </label>`).join("")}
    </div>
  </div>`;

  const tiersBlock = `
  <div class="card">
    <h3 class="fw" style="margin-bottom:14px">${t("admin.editor.tiers")}</h3>
    ${d.indicators.map((ind, i) => {
      if (isCompositeInput(ind)) {
        // 复合分已解锁（2026-08-13）：分项档位可编辑
        return ind.composite.components.map((c, ci) => `
        <div style="margin-bottom:16px">
          <p class="fw small" style="margin-bottom:6px">${t(`indicator.${ind.key}`)} · ${t(`rules.credit.${c.key}`)}
            <span class="faint">${t("common.paren_open")}% · ${t(`direction.${c.direction}`)}${t("common.paren_close")}</span></p>
          <div class="tier-grid num">
            ${c.tiers.map((tier, j) => {
              const k = thresholdKey(tier);
              return `
              <span class="small faint">${t("admin.editor.tier_threshold")} ${k}</span>
              <input type="number" step="any" ${tier[k] === null ? 'disabled value="—"' : `value="${tier[k]}" data-path="indicators.${i}.composite.components.${ci}.tiers.${j}.${k}"`}>
              <span class="small faint">${t("admin.editor.tier_score")}</span>
              <input type="number" step="1" value="${tier.score}" data-path="indicators.${i}.composite.components.${ci}.tiers.${j}.score">`;
            }).join("")}
          </div>
        </div>`).join("") +
        `<p class="faint small" style="margin:0 0 16px">${t("admin.editor.credit_unlocked_note")}</p>`;
      }
      return `
      <div style="margin-bottom:16px">
        <p class="fw small" style="margin-bottom:6px">${t(`indicator.${ind.key}`)} <span class="faint">${t("common.paren_open")}${tUnit(ind)} · ${t(`direction.${ind.direction}`)}${t("common.paren_close")}</span></p>
        <div class="tier-grid num">
          ${ind.tiers.map((tier, j) => {
            const k = thresholdKey(tier);
            return `
            <span class="small faint">${t("admin.editor.tier_threshold")} ${k}</span>
            <input type="number" step="any" ${tier[k] === null ? 'disabled value="—"' : `value="${tier[k]}" data-path="indicators.${i}.tiers.${j}.${k}"`}>
            <span class="small faint">${t("admin.editor.tier_score")}</span>
            <input type="number" step="1" value="${tier.score}" data-path="indicators.${i}.tiers.${j}.score">`;
          }).join("")}
        </div>
      </div>`;
    }).join("")}
  </div>`;

  const incentiveBlock = `
  <div class="card">
    <h3 class="fw" style="margin-bottom:14px">${t("admin.editor.incentive")}</h3>
    <div class="form-grid">
      ${["S", "A"].map((lv) => numField(t("admin.editor.rate", { level: lv, currency }), `incentive.rates.${lv}`, d.incentive.rates[lv])).join("")}
      ${numField(t("admin.editor.cap", { currency }), "incentive.per_vendor_monthly_cap", d.incentive.per_vendor_monthly_cap, { step: 10000 })}
    </div>
  </div>`;

  const redlineBlock = `
  <div class="card">
    <h3 class="fw" style="margin-bottom:14px">${t("admin.editor.redline")}</h3>
    <div class="form-grid">
      ${numField(t("admin.editor.rl_amount", { currency }), "redline.weekly_hit.overdue_7d_amount_gte", d.redline.weekly_hit.overdue_7d_amount_gte, { step: 5000 })}
      ${numField(t("admin.editor.rl_ratio"), "redline.weekly_hit.overdue_ratio_gte", d.redline.weekly_hit.overdue_ratio_gte)}
      ${numField(t("admin.editor.rl_hits"), "redline.trigger.monthly_hits_gte", d.redline.trigger.monthly_hits_gte)}
      <label class="field"><span class="faint small">${t("admin.editor.rl_cap")}</span>
        <select data-path-select="redline.level_cap">
          <option value="" ${d.redline.level_cap == null ? "selected" : ""}>${t("admin.editor.rl_cap_none")}</option>
          ${["A", "B", "C"].map((lv) => `<option value="${lv}" ${d.redline.level_cap === lv ? "selected" : ""}>${lv}</option>`).join("")}
        </select>
      </label>
    </div>
  </div>`;

  const protectionBlock = `
  <div class="card">
    <h3 class="fw" style="margin-bottom:14px">${t("admin.editor.protection")}</h3>
    <div class="form-grid">
      ${numField(t("admin.editor.exempt_months"), "new_vendor_protection.exempt_months", d.new_vendor_protection.exempt_months)}
      ${numField(t("admin.editor.cutoff_day"), "new_vendor_protection.counting_start_rule.cutoff_day", d.new_vendor_protection.counting_start_rule.cutoff_day)}
      ${numField(t("admin.editor.consecutive_c"), "clearance.consecutive_c_months", d.clearance.consecutive_c_months)}
    </div>
  </div>`;

  const saveBlock = `
  <div class="card">
    ${errs.length ? `<ul class="err-list">${errs.map((e) => `<li>${e}</li>`).join("")}</ul>` : ""}
    <div class="form-grid">
      <label class="field"><span class="faint small">${t("admin.editor.effective_from")}</span>
        <input type="text" id="effective-from" value="${d.effective_from}" placeholder="YYYY-MM"></label>
    </div>
    <label class="field" style="margin-top:12px;display:block">
      <span class="faint small">${t("admin.editor.reason")}</span>
      <textarea id="change-reason" rows="2" style="width:100%"></textarea>
    </label>
    <div style="display:flex;gap:12px;align-items:center;margin-top:16px;flex-wrap:wrap">
      <button type="button" class="btn" id="btn-simulate" ${errs.length ? "disabled" : ""}>${t("admin.editor.simulate")}</button>
      <button type="button" class="btn" id="btn-save" disabled>${t("admin.editor.save")}</button>
      <span class="faint small">${t("admin.editor.save_gate")}</span>
    </div>
    <div id="save-msg" class="small" style="margin-top:10px"></div>
    <div id="sim-container">${simDone ? lastSimHTML : ""}</div>
  </div>`;

  return `${flashMsg ? `<div class="card" style="border-color:var(--action)"><p class="small">${flashMsg}</p></div>` : ""}
    ${linesBlock}${weightsBlock}${tiersBlock}${incentiveBlock}${redlineBlock}${protectionBlock}${saveBlock}`;
}

function bindEditor(ctx, container, rerender) {
  const { rules, vendorsData } = ctx;
  container.querySelectorAll("input[data-path]").forEach((input) => {
    input.addEventListener("change", () => {
      const scale = Number(input.dataset.scale || 1);
      const v = Number(input.value);
      setPath(draft, input.dataset.path, scale === 1 ? v : v / scale);
      simDone = false;
      rerender();
    });
  });
  container.querySelector("select[data-path-select]")?.addEventListener("change", (e) => {
    setPath(draft, e.target.dataset.pathSelect, e.target.value === "" ? null : e.target.value);
    simDone = false;
    rerender();
  });
  container.querySelectorAll("input[data-enabled-index]").forEach((cb) => {
    cb.addEventListener("change", () => {
      draft.indicators[Number(cb.dataset.enabledIndex)].enabled = cb.checked ? true : false;
      simDone = false;
      rerender();
    });
  });
  container.querySelector("#btn-simulate")?.addEventListener("click", () => {
    const errs = validateDraft(draft);
    if (errs.length) { rerender(); return; }
    const sim = simulate(rules, draft, vendorsData, ctx.period);
    lastSimHTML = simHTML(sim, draft.incentive.currency);
    simDone = true;
    rerender();
    container.querySelector("#btn-save")?.removeAttribute("disabled");
  });
  if (simDone) container.querySelector("#btn-save")?.removeAttribute("disabled");
  container.querySelector("#btn-save")?.addEventListener("click", async () => {
    const msgEl = container.querySelector("#save-msg");
    const reason = container.querySelector("#change-reason").value.trim();
    const effective = container.querySelector("#effective-from").value.trim();
    const errs = validateDraft(draft);
    if (!simDone) { msgEl.textContent = t("admin.editor.save_gate"); return; }
    if (!/^\d{4}-\d{2}$/.test(effective)) { msgEl.textContent = t("admin.check.effective_format"); return; }
    if (!reason) { msgEl.textContent = t("admin.check.reason_required"); return; }
    if (errs.length) { rerender(); return; }
    const changes = diffLines(rules, draft);
    if (!changes.length) { msgEl.textContent = t("admin.editor.no_changes"); return; }
    const final = structuredClone(draft);
    final.effective_from = effective;
    final.changelog = [...final.changelog, {
      version: final.version,
      effective_from: effective,
      date: new Date().toISOString().slice(0, 10),
      summary_text: reason.split("\n")[0].slice(0, 40),
      changes_texts: changes,
      reason_text: reason,
    }];
    if (!RULES_WRITABLE) {
      // 线上不写库：规则改动一律走「变更单 → 本地改 rules.json → 四件套 → 导入」这条唯一路径
      msgEl.textContent = t("admin.editor.readonly_online");
      return;
    }
    try {
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: final, reason }),
      }).then((r) => r.json());
      if (!res.ok) throw new Error(res.error ?? "unknown");
      flashMsg = t("admin.editor.saved", { backup: res.backup });
      simDone = false; lastSimHTML = ""; draft = null;
      await ctx.onRulesSaved();
    } catch (e) {
      msgEl.textContent = t("admin.editor.save_failed", { msg: e.message });
    }
  });
}

/* ---------------- 沙盘 ---------------- */
function sandboxHTML(ctx) {
  const { rules, vendorsData } = ctx;
  const lines = sandboxLines;
  const trial = structuredClone(rules);
  trial.level_lines.by_city = structuredClone(lines);
  const sim = simulate(rules, trial, vendorsData, ctx.period);
  const [lo, hi] = rules.level_lines.design_target_sa_ratio.map((x) => x * 100);

  const sliders = Object.entries(lines).map(([city, l]) => ["A", "C"].map((k) => `
    <div class="sim-row">
      <div class="sim-head">
        <span class="fw">${city} · ${k} ${t("admin.editor.lines")}</span>
        <span class="num muted" id="sb-val-${city}-${k}">${l[k]}</span>
      </div>
      <input type="range" min="0" max="100" step="1" value="${l[k]}" data-sb="${city}.${k}">
    </div>`).join("")).join("");

  const saRows = Object.entries(sim.cities).map(([city, c]) => {
    const n = c.new.S + c.new.A + c.new.B + c.new.C;
    const sa = ((c.new.S + c.new.A) / n) * 100;
    const inTarget = sa >= lo && sa <= hi;
    return `<tr><td class="fw">${city}</td>
      <td class="n num">${c.new.S} / ${c.new.A} / ${c.new.B} / ${c.new.C}</td>
      <td class="n num">${fmtNumber(sa, { maximumFractionDigits: 1 })}%
        <span class="${inTarget ? "ok-text" : "err-text"}">${inTarget ? t("admin.sandbox.sa_in_target") : t("admin.sandbox.sa_out_target")}</span></td></tr>`;
  }).join("");

  const alts = Object.entries(rules.level_lines.alternatives ?? {})
    .filter(([k]) => !k.startsWith("_"))
    .flatMap(([city, arr]) => arr.map((alt) =>
      `<button type="button" class="scope-btn" data-alt="${city}.${alt.A}">${
        t("admin.sandbox.alt_btn", { city, a: alt.A, sa: fmtNumber(alt.expected_sa * 100) })}</button>`)).join("");

  return `
  <div class="card">
    <p class="faint small" style="margin-bottom:8px">${t("admin.sandbox.hint")}${t("common.paren_open")}${fmtNumber(lo)}–${fmtNumber(hi)}%${t("common.paren_close")}</p>
    ${sliders}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      ${alts}
      <button type="button" class="scope-btn" id="sb-reset">${t("admin.sandbox.reset")}</button>
      <button type="button" class="btn" id="sb-to-editor">${t("admin.sandbox.to_editor")}</button>
    </div>
  </div>
  <div class="card" style="margin-top:18px">
    <div class="table-scroll"><table>
      <thead><tr><th>${t("admin.sim.city")}</th><th class="n">${t("admin.sim.dist")}</th><th class="n">${t("admin.sim.sa")}</th></tr></thead>
      <tbody>${saRows}</tbody>
    </table></div>
    <p class="num" style="margin-top:12px">${t("admin.sim.cost")}${t("common.colon")}${fmtCurrency(sim.oldCost, rules.incentive.currency)} → <b>${fmtCurrency(sim.newCost, rules.incentive.currency)}</b></p>
    <p class="small muted" style="margin-top:6px">${sim.affected.length
      ? t("admin.sim.affected", { n: fmtNumber(sim.affected.length) })
      : t("admin.sim.affected_none")}</p>
    <p class="faint small" style="margin-top:6px">${t("admin.sim.cost_note")}</p>
  </div>`;
}

function bindSandbox(ctx, container, rerender) {
  container.querySelectorAll("input[data-sb]").forEach((slider) => {
    slider.addEventListener("input", () => {
      const [city, k] = slider.dataset.sb.split(".");
      sandboxLines[city][k] = Number(slider.value);
      const el = container.querySelector(`#sb-val-${city}-${k}`);
      if (el) el.textContent = slider.value;
    });
    slider.addEventListener("change", rerender);
  });
  container.querySelectorAll("[data-alt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [city, a] = btn.dataset.alt.split(".");
      sandboxLines[city].A = Number(a);
      rerender();
    });
  });
  container.querySelector("#sb-reset")?.addEventListener("click", () => {
    sandboxLines = structuredClone(ctx.rules.level_lines.by_city);
    rerender();
  });
  container.querySelector("#sb-to-editor")?.addEventListener("click", () => {
    draft ??= structuredClone(ctx.rules);
    draft.level_lines.by_city = structuredClone(sandboxLines);
    simDone = false;
    activeTab = "editor";
    rerender();
  });
}

/* ---------------- 数据查看 ---------------- */
let dataFilter = "";
function dataHTML(ctx) {
  const { rules, vendorsData, profilesByCode } = ctx;
  const q = dataFilter.trim().toUpperCase();
  const rows = vendorsData.vendors
    .filter((v) => {
      if (!q) return true;
      const name = (profilesByCode[v.vendor_code]?.display_name ?? "").toUpperCase();
      return v.vendor_code.toUpperCase().includes(q) || name.includes(q);
    })
    .sort((a, b) => b.total_score - a.total_score)
    .map((v) => {
      const p = profilesByCode[v.vendor_code];
      const prot = protectionStatus(p?.first_order_date ?? null, ctx.period.month, rules.new_vendor_protection);
      const flags = [
        v.redline ? `<span class="chip alert">${t("admin.flag.redline")}</span>` : "",
        v.double_zero ? `<span class="chip">${t("admin.flag.dz")}</span>` : "",
        v.s_scale_gate_blocked ? `<span class="chip">${t("admin.flag.gate")}</span>` : "",
        prot.status === "exempt" ? `<span class="chip">${t("admin.flag.protected")}</span>` : "",
        prot.status === "unknown" ? `<span class="chip">${t("admin.flag.unknown_protection")}</span>` : "",
      ].join("");
      return `
      <tr>
        <td><span class="fw">${p?.display_name ?? v.vendor_code}</span><br>
            <span class="faint small num">${v.vendor_code} · ${v.city}</span></td>
        <td>${badgeSmall(v.level, 20)}</td>
        <td class="n num">${fmtPoints(v.total_score)}</td>
        <td>${p?.rm ?? t("common.rm_unassigned")}</td>
        <td>${flags}</td>
      </tr>`;
    }).join("");
  return `
  <div class="card">
    <div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">
      <input type="search" id="data-search" placeholder="${t("admin.data.search")}" value="${dataFilter}" style="flex:1;max-width:340px">
      <span class="faint small">${t("admin.data.count", { n: fmtNumber(vendorsData.vendors.length) })}</span>
    </div>
    <div class="table-scroll"><table>
      <thead><tr><th>${t("admin.h.vendor")}</th><th>${t("admin.h.level")}</th>
        <th class="n">${t("admin.h.points")}</th><th>${t("admin.h.rm")}</th><th>${t("admin.h.flags")}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function bindData(ctx, container, rerender) {
  const input = container.querySelector("#data-search");
  input?.addEventListener("input", () => {
    dataFilter = input.value;
    const pos = input.selectionStart;
    rerender();
    const el = document.getElementById("data-search");
    el?.focus();
    el?.setSelectionRange(pos, pos);
  });
}

/* ---------------- 历史与回滚 ---------------- */
function historyHTML() {
  return `
  <div class="card">
    <h3 class="fw" style="margin-bottom:12px">${t("admin.history.backups")}</h3>
    <div id="history-list" class="small muted">…</div>
    <div id="history-msg" class="small" style="margin-top:10px"></div>
  </div>`;
}

async function bindHistory(ctx, container) {
  const list = container.querySelector("#history-list");
  if (!RULES_WRITABLE) {
    // rules_history/ 是本地目录，线上没有；历史版本查阅走仓库与 docs/上线记录
    list.textContent = t("admin.history.local_only");
    return;
  }
  try {
    const res = await fetch("/api/rules_history").then((r) => r.json());
    if (!res.files.length) { list.textContent = t("admin.history.empty"); return; }
    list.innerHTML = res.files.map((f) => `
      <div style="display:flex;gap:14px;align-items:center;padding:8px 0;border-bottom:0.5px solid var(--hairline)">
        <span class="num" style="flex:1">${f}</span>
        <button type="button" class="scope-btn" data-restore="${f}">${t("admin.history.restore")}</button>
      </div>`).join("");
    list.querySelectorAll("[data-restore]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.dataset.armed !== "1") {
          btn.dataset.armed = "1";
          btn.textContent = t("admin.history.restore_confirm");
          btn.classList.add("active");
          return;
        }
        const res2 = await fetch("/api/rules_restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: btn.dataset.restore }),
        }).then((r) => r.json());
        if (res2.ok) {
          flashMsg = t("admin.history.restored", { file: res2.restored, backup: res2.backup });
          draft = null; simDone = false; lastSimHTML = "";
          await ctx.onRulesSaved();
        } else {
          container.querySelector("#history-msg").textContent = t("admin.editor.save_failed", { msg: res2.error });
        }
      });
    });
  } catch {
    list.textContent = t("admin.history.load_failed");
  }
}

/* ---------------- 入口 ---------------- */
export function renderAdmin() {
  const tabs = ["editor", "sandbox", "data", "history"].map((k) =>
    `<button type="button" class="scope-btn ${activeTab === k ? "active" : ""}" data-admin-tab="${k}">${t(`admin.tab.${k}`)}</button>`).join("");
  return `
  <section class="section">
    <h2 class="page-title">${t("admin.title")}</h2>
    <p class="faint small" style="margin:10px 0 16px">${t(RULES_WRITABLE ? "admin.demo_note" : "admin.online_note")}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">${tabs}</div>
    <div id="admin-body"></div>
  </section>`;
}

export function bindAdmin(ctx) {
  draft ??= structuredClone(ctx.rules);
  sandboxLines ??= structuredClone(ctx.rules.level_lines.by_city);

  const body = document.getElementById("admin-body");
  const renderTab = () => {
    if (activeTab === "editor") {
      body.innerHTML = editorHTML(ctx.rules);
      bindEditor(ctx, body, renderTab);
    } else if (activeTab === "sandbox") {
      body.innerHTML = sandboxHTML(ctx);
      bindSandbox(ctx, body, renderTab);
    } else if (activeTab === "data") {
      body.innerHTML = dataHTML(ctx);
      bindData(ctx, body, renderTab);
    } else {
      body.innerHTML = historyHTML();
      bindHistory(ctx, body);
    }
    flashMsg = "";
  };

  document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.adminTab;
      document.querySelectorAll("[data-admin-tab]").forEach((b) =>
        b.classList.toggle("active", b.dataset.adminTab === activeTab));
      renderTab();
    });
  });
  renderTab();
}

/** 规则保存/回滚后由 app.js 调用：清空工作副本 */
export function resetAdminState() {
  draft = null;
  sandboxLines = null;
  simDone = false;
  lastSimHTML = "";
}
