// 总览页（需求文档 6.2）。展示数字全部来自 data/ 源值；
// 派生布尔（S 门槛拦截、双 0、差距、贡献）由引擎按 rules.json 现算（铁律 16），不读存储标记、不读 note。

import { t, fmtPoints, fmtNumber } from "../i18n.js";
import { computeScores, determineLevel, adviceBranch, applyFlexAdjustment } from "../engine/rules.js";
import { protectionStatus } from "../engine/protection.js";
import { focusIndicators } from "../engine/advice.js";
import { badgeLarge, badgeSmall } from "../components/badge.js";
import { tierTrackMini } from "../components/tiertrack.js";

export function renderOverview({ rules, vendor, profile, period, stats }) {
  const values = Object.fromEntries(vendor.indicators.map((i) => [i.key, i.value]));
  const { scores } = computeScores(rules, values);
  const gate = rules.s_scale_gate;
  const lines = { ...rules.level_lines.shared, ...rules.level_lines.by_city[vendor.city] };
  // 灵活分作为已知输入进入综合分（加/扣分分开展示，净值参与判级；门槛与红线封顶仍是硬约束）
  const flex = applyFlexAdjustment(rules, vendor.total_score, vendor.flex_adjustments ?? []);
  const displayTotal = flex.adjusted;
  const { sScaleGateBlocked, levelBeforeCap } = determineLevel(rules, vendor.city, displayTotal, values, {
    redline: vendor.redline,
  });
  const branch = adviceBranch(rules, scores);
  const gateIndicatorName = t(`indicator.${gate.indicator}`);

  // —— 主卡 ——
  const officialCompare = vendor.level_official_v1
    ? `<span>${t("overview.compare_official", { level: vendor.level_official_v1 })}</span>
       <span class="${vendor.level_change === "↑" ? "delta-up" : "delta-down"}">${
         vendor.level_change === "↑" ? t("overview.delta_up")
         : vendor.level_change === "↓" ? t("overview.delta_down")
         : t("overview.delta_flat")}</span>`
    : "";

  const hero = `
  <section class="section">
    <div class="card hero-card">
      ${badgeLarge(vendor.level, 150)}
      <div class="hero-main">
        <div class="hero-kicker">${t(period.type === "weekly" ? "overview.kicker_weekly" : "overview.kicker", { period: period.weeks ?? period.label })}</div>
        <!-- 「测算稿」角标于 2026-08-17 随顶部横幅一并下线，见 app.js 处的说明 -->
        <div class="points-label">${t("common.points")}</div>
        <div class="num-lg num">${fmtPoints(displayTotal)}</div>
        ${(flex.bonus || flex.penalty) ? `
        <div class="small num" style="margin-top:4px">
          <span class="muted">${t("overview.flex_base", { base: fmtPoints(vendor.total_score) })}</span>
          ${flex.bonus ? ` <span class="fw">${t("overview.flex_bonus", { n: fmtPoints(flex.bonus) })}</span>` : ""}
          ${flex.penalty ? ` <span style="color:var(--alert)">${t("overview.flex_penalty", { n: fmtPoints(flex.penalty) })}</span>` : ""}
        </div>` : ""}
        <div class="hero-meta">
          <span>${profile?.display_name ?? vendor.vendor_code}</span>
          <span>${vendor.city}</span>
          ${officialCompare}
        </div>
        <div class="faint" style="margin-top:8px">${t("overview.level_line_note", {
          s: fmtNumber(lines.S), a: fmtNumber(lines.A), c: fmtNumber(lines.C),
        })}</div>
        ${statusChips({ rules, vendor, profile })}
      </div>
    </div>
    ${gateCard()}
    ${nextLevelCard()}
  </section>`;

  function statusChips({ rules, vendor, profile }) {
    const chips = [];
    if (period.type === "weekly") {
      // 周度只能判「单周命中」，触发需当月≥2次且月末仍命中——不可说成已触发
      chips.push(vendor.redline_week_hit
        ? `<span class="chip alert"><span class="dot"></span>${t("overview.redline_week_hit")}</span>`
        : `<span class="chip"><span class="dot" style="background:var(--ink-3)"></span>${t("overview.redline_week_ok")}</span>`);
    } else {
      chips.push(vendor.redline
        ? `<span class="chip alert"><span class="dot"></span>${t("overview.redline_hit")} · ${t("overview.redline_recover")}</span>`
        : `<span class="chip"><span class="dot" style="background:var(--ink-3)"></span>${t("overview.redline_ok")}</span>`);
    }
    // 周度是试算快照，不计入保护期与清退累计 → 不显示保护期状态（数据侧也为 null）
    const prot = period.type === "weekly"
      ? { status: "n/a", exemptMonths: [] }
      : protectionStatus(profile?.first_order_date ?? null, period.month, rules.new_vendor_protection);
    if (prot.status === "exempt") {
      chips.push(`<span class="chip">${t("overview.protection_exempt", {
        until: prot.exemptMonths[prot.exemptMonths.length - 1] })}</span>`);
    } else if (prot.status === "unknown") {
      chips.push(`<span class="chip">${t("overview.protection_unknown")}</span>`);
    }
    return `<div class="status-row">${chips.join("")}</div>`;
  }

  function gateCard() {
    if (!sScaleGateBlocked) return "";
    return `
    <div class="card">
      <h3 class="fw" style="margin-bottom:8px">${t("overview.gate_blocked_title")}</h3>
      <p class="muted">${t("overview.gate_blocked_body", {
        points: fmtPoints(displayTotal),
        sline: fmtNumber(lines.S),
        indicator: gateIndicatorName,
        value: fmtNumber(values[gate.indicator], { maximumFractionDigits: 0 }),
        unit: rules.indicators.find((i) => i.key === gate.indicator)?.unit ?? "",
        gate: fmtNumber(gate.gte),
      })}</p>
    </div>`;
  }

  /**
   * 距下一等级：一条完整的四段等级尺（2026-08-16 用户要求）。
   * 四个等级按各自的分数跨度排在同一条尺上，边界标出本城分数线，当前分打点，右上角显示还差多少。
   * 全部分数线来自 rules.json 的本城配置，本函数无任何字面值。
   */
  function nextLevelCard() {
    // 被 S 规模门槛拦截的商：分差为负且无意义，gateCard 已完整解释——不再渲染本卡
    if (sScaleGateBlocked) return "";

    // 尺的量程：0 → 100（综合分满分）；灵活分可能把总分顶过 100，那就把尺加长到装得下
    const scaleMax = Math.max(100, Math.ceil(displayTotal));
    // 四段：C[0, C线) · B[C线, A线) · A[A线, S线) · S[S线, 量程上限]
    const segs = [
      { level: "C", from: 0, to: lines.C },
      { level: "B", from: lines.C, to: lines.A },
      { level: "A", from: lines.A, to: lines.S },
      { level: "S", from: lines.S, to: scaleMax },
    ].map((s) => ({ ...s, width: (Math.max(s.to - s.from, 0) / scaleMax) * 100 }));

    // 下一级目标：C 的目标是脱离 C（达到 C 线，即进入 B）
    const target = vendor.level === "S" ? null
      : vendor.level === "A" ? { level: "S", line: lines.S }
      : vendor.level === "B" ? { level: "A", line: lines.A }
      : { level: "B", line: lines.C };
    const gap = target ? target.line - displayTotal : 0;
    const reached = target ? gap <= 0 : false;
    const markPct = Math.min(Math.max(displayTotal / scaleMax, 0), 1) * 100;

    const headRight = !target
      ? `<span class="num fw">${t("overview.progress_reached", { level: "S" })}</span>`
      : reached
        ? `<span class="num fw">${t("overview.progress_reached", { level: target.level })}</span>`
        : `<span class="num lp-gap">${t("overview.progress_gap", { gap: fmtPoints(gap) })}</span>`;

    // 边界刻度：只标分数线本身（0 和量程上限不标，避免刻度过密）
    const ticks = segs.slice(1).map((s) =>
      `<span class="lvbar-tick num" style="left:${((s.from / scaleMax) * 100).toFixed(2)}%">
         <i></i><b>${fmtNumber(s.from)}</b></span>`).join("");

    // 无障碍：一句话把尺上的全部信息读出来，不依赖视觉
    const aria = t("overview.bar_aria", {
      points: fmtPoints(displayTotal), level: vendor.level,
      c: fmtNumber(lines.C), a: fmtNumber(lines.A), s: fmtNumber(lines.S),
    });

    return `
    <div class="card">
      <div class="lp-head">
        <h3 class="fw">${t("overview.next_gap_title")}</h3>
        ${headRight}
      </div>
      <div class="lvbar-wrap" role="img" aria-label="${aria}">
        <div class="lvbar-mark" style="left:${markPct.toFixed(2)}%">
          <span class="lvbar-mark-label num fw">${t("overview.progress_current", { points: fmtPoints(displayTotal) })}</span>
          <i></i>
        </div>
        <div class="lvbar">
          ${segs.map((s) => `
            <div class="lvbar-seg lv-${s.level}${s.level === vendor.level ? " current" : ""}"
                 style="width:${s.width.toFixed(2)}%"><span>${s.level}</span></div>`).join("")}
        </div>
        <div class="lvbar-ticks">${ticks}</div>
      </div>
      ${target && !reached
        ? `<p class="faint small" style="margin-top:26px">${t("overview.bar_next_note", {
             level: target.level, line: fmtNumber(target.line), gap: fmtPoints(gap) })}</p>`
        : `<p class="faint small" style="margin-top:26px">${t("overview.at_top_simple", {
             sline: fmtNumber(lines.S) })}</p>`}
      ${levelBeforeCap && levelBeforeCap !== vendor.level
        ? `<p class="small" style="margin-top:8px;color:var(--alert)">${
             t("rules.redline.level_cap", { level: vendor.level })}</p>`
        : ""}
    </div>`;
  }

  // —— 我的排名（2026-08-14 起并入本页；不披露总家数，也不含其他商身份） ——
  const rankSection = (() => {
    const pv = stats?.perVendor?.[vendor.vendor_code];
    if (!pv) return "";
    // 任一名次缺失就不渲染该条（阶段二若 rank_level 列未就位，宁可少显示一项，也不显示 undefined）
    const items = [];
    if (pv.rank_level != null) {
      items.push(`<span class="badge-inline">${badgeSmall(vendor.level, 24)}
        <span class="num fw" style="font-size:24px">${t("overview.rank_in_level", {
          level: vendor.level, rank: fmtNumber(pv.rank_level) })}</span></span>`);
    }
    if (pv.rank_city != null) {
      items.push(`<span class="num fw" style="font-size:24px">${t("overview.rank_in_city", {
        city: vendor.city, rank: fmtNumber(pv.rank_city) })}</span>`);
    }
    if (!items.length) return "";
    return `
    <section class="section">
      <h2>${t("overview.rank_title")}</h2>
      <div class="card" style="display:flex;gap:48px;flex-wrap:wrap;align-items:baseline">
        ${items.join("")}
      </div>
      <p class="faint small" style="margin-top:10px">${t("overview.rank_note")}</p>
    </section>`;
  })();

  // —— 最需关注 ——
  const focus = focusIndicators(rules, values, scores, branch, 2);
  const focusCards = focus.length
    ? focus.map((f) => `
      <div class="card">
        <h3 class="fw">${t(`indicator.${f.key}`)}</h3>
        ${tierTrackMini(f.rule, f.value, f.score, f.gain)}
        <div style="margin-top:12px"><a href="#/advice">${t("overview.go_advice")}</a></div>
      </div>`).join("")
    : `<div class="card muted">${t("overview.focus_empty")}</div>`;

  const dzHint = branch?.key === "double_zero"
    ? `<p class="muted small" style="margin-bottom:12px">${t("overview.dz_hint")}</p>` : "";

  const focusSection = `
  <section class="section">
    <h2>${t("overview.focus_title")}</h2>
    ${dzHint}
    <div class="focus-grid">${focusCards}</div>
  </section>`;

  return hero + rankSection + focusSection;
}
