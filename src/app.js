// 应用入口：数据加载 + 权重校验 + 角色/Vendor 切换器 + hash 路由 + 壳层渲染。
// AUTH_ENABLED=false：阶段一用切换器模拟身份（需求文档「登录开关」）。前端过滤仅是演示手段，不是安全机制。

import { initI18n, t, LANGS, currentLang } from "./i18n.js";
import { loadStatic, loadPeriodData, reloadRules, normalizePeriod, SOURCE, needsAuth } from "./data.js";
import { isSignedIn, signOut } from "./supabase.js";
import { renderLogin, bindLogin } from "./views/login.js";
import { validateRules } from "./engine/rules.js";
import { renderOverview } from "./views/overview.js";
import { renderRules } from "./views/rules.js";
import { renderPerformance } from "./views/performance.js";
import { renderAdvice, bindAdvice } from "./views/advice.js";
import { renderEarnings } from "./views/earnings.js";
import { renderAdmin, bindAdmin, resetAdminState } from "./views/admin.js";
import { renderBenchmark } from "./views/benchmark.js";
import { renderPortfolio, bindPortfolio } from "./views/portfolio.js";

// 认证开关由数据源决定，不用注释掉代码的方式切换（需求文档「登录开关」）：
//   SOURCE=local     → 演示模式，角色/Vendor 由切换器模拟
//   SOURCE=supabase  → 上线模式，必须登录，身份来自 vg_user_roles + RLS
const AUTH_ENABLED = needsAuth();
const STATE_KEY = "alianza_site_state_v1";

const app = document.getElementById("app");
let rules, vendorsData, profileData, periodsIndex, period;
let profilesByCode = {};
let identity = null; // supabase 模式下由 vg_user_roles 决定，切换器隐藏
// periodType/periodId：当前查看的评定期（月度=正式评级，周度=试算快照）
let state = { role: "vendor", vendorCode: null, rmName: null, periodType: null, periodId: null, lang: "zh" };
let rmList = [];

// 排名并入总览页（2026-08-14 用户要求），/ranking 独立页已下线
const ROUTES = ["portfolio", "overview", "benchmark", "rules", "performance", "advice", "earnings", "admin"];
const NAV_FOR_ROLE = {
  vendor: ["overview", "rules", "performance", "advice", "earnings"],
  rm: ["portfolio", "overview", "benchmark", "rules", "performance", "advice", "earnings"],
  ops: ["portfolio", "overview", "benchmark", "rules", "performance", "advice", "earnings"],
  admin: ROUTES,
};

/** 搜索归一化：去重音 + 大写 + 压空白。已知源表写法不一致（ENVÍAGUIA/ENVIAGUIA、ALEJANDRO/Alejandro） */
function normalizeSearch(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Vendor 选择器：当前可选清单与搜索词（内部角色用，100+ 家靠下拉找太慢） */
let vendorPickList = [];
let vendorFilter = "";

function vendorOptionsHTML(list) {
  const q = normalizeSearch(vendorFilter);
  const matched = q ? list.filter((x) => x.haystack.includes(q)) : list;
  if (!matched.length) return `<option value="">${t("switcher.vendor_no_match")}</option>`;
  return matched
    .map((x) => `<option value="${x.code}"${x.code === state.vendorCode ? " selected" : ""}>${x.label}</option>`)
    .join("");
}

/** RM 视角下可见的 Vendor：自己名下（标杆视图内的 S 商单独处理，不进选择器） */
function visibleVendors() {
  if (state.role === "rm" && state.rmName) {
    return vendorsData.vendors.filter((v) => profilesByCode[v.vendor_code]?.rm === state.rmName);
  }
  return vendorsData.vendors;
}

/** 当前选中期的 periods.json 条目 */
function periodEntry() {
  const list = state.periodType === "weekly" ? periodsIndex.weekly : periodsIndex.monthly;
  return list.find((e) => e.id === state.periodId) ?? list[0] ?? null;
}

/** 切换评定期：重载该期数据，必要时修正当前 Vendor（各期家数不同） */
async function switchPeriod(type, id) {
  state.periodType = type;
  state.periodId = id;
  const entry = periodEntry();
  vendorsData = await loadPeriodData(entry, rules);
  period = normalizePeriod(entry, t);
  if (!vendorsData.vendors.some((x) => x.vendor_code === state.vendorCode)) {
    const roster = visibleVendors();
    state.vendorCode = (roster[0] ?? vendorsData.vendors[0]).vendor_code;
  }
  saveState();
  render();
}

async function boot() {
  // 语言：先读已保存的选择再初始化 i18n（缺译自动回退中文母本，见 src/i18n.js）
  try {
    const saved0 = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null");
    if (saved0?.lang && LANGS.includes(saved0.lang)) state.lang = saved0.lang;
  } catch {}
  await initI18n(state.lang);
  if (AUTH_ENABLED && !isSignedIn()) {
    app.innerHTML = renderLogin();
    bindLogin(boot);   // 登录成功后重新引导
    return;
  }
  try {
    const s = await loadStatic();
    rules = validateRules(s.rules);
    profileData = s.profileData;
    periodsIndex = s.periodsIndex;
    identity = s.identity;
  } catch (e) {
    if (e?.code === "auth.required") {          // token 失效 → 回登录页，不展示空数据
      signOut();
      app.innerHTML = renderLogin();
      bindLogin(boot);
      return;
    }
    const msg = e?.code === "auth.no_role" ? t("error.no_role")
      : e?.code === "rules.weight_sum_invalid" ? t("error.rules_invalid", { msg: e.message })
      : t("error.load");
    app.innerHTML = `<main><div class="empty-state">${msg}</div></main>`;
    return;
  }
  profilesByCode = Object.fromEntries(profileData.profiles.map((x) => [x.vendor_code, x]));
  rmList = [...new Set(profileData.profiles.map((p) => p.rm).filter(Boolean))].sort();

  const saved = localStorage.getItem(STATE_KEY);
  if (saved) {
    try { state = { ...state, ...JSON.parse(saved) }; } catch {}
  }
  if (AUTH_ENABLED && identity) {
    // 上线模式：角色与身份来自数据库，用户不能自选（切换器只在演示模式出现）
    state.role = identity.role;
    if (identity.role === "vendor" && identity.vendorCode) state.vendorCode = identity.vendorCode;
    if (identity.role === "rm" && identity.rmName) state.rmName = identity.rmName;
  }
  if (!state.rmName || !rmList.includes(state.rmName)) state.rmName = rmList[0] ?? null;

  // 评定期：沿用上次选择，失效则回落到索引默认（月度最新一期）
  const valid = (type, id) => (type === "weekly" ? periodsIndex.weekly : periodsIndex.monthly ?? [])
    .some((e) => e.id === id);
  if (!state.periodType || !valid(state.periodType, state.periodId)) {
    state.periodType = periodsIndex.default.type;
    state.periodId = periodsIndex.default.id;
  }
  const entry = periodEntry();
  vendorsData = await loadPeriodData(entry, rules);
  period = normalizePeriod(entry, t);
  if (!state.vendorCode || !vendorsData.vendors.some((x) => x.vendor_code === state.vendorCode)) {
    state.vendorCode = vendorsData.vendors[0].vendor_code;
  }

  window.addEventListener("hashchange", render);
  render();
}

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

/** 规则保存/回滚后重载规则并全站重渲染 */
async function onRulesSaved() {
  rules = validateRules(await reloadRules());
  resetAdminState();
  render();
}

function currentRoute() {
  const h = location.hash.replace(/^#\/?/, "").trim();
  // RM/内部角色默认落在「我的商盘」全盘视图（用户要求：先看全局，再点进单商）
  if (h === "") return state.role === "vendor" ? "overview" : "portfolio";
  return h;
}

function render() {
  const route = currentRoute();
  // RM 视角：当前 vendor 必须在自己名下，不在则切到名下第一家（数据隔离，铁律 7）
  if (state.role === "rm") {
    const roster = visibleVendors();
    if (roster.length && !roster.some((v) => v.vendor_code === state.vendorCode)) {
      state.vendorCode = roster[0].vendor_code;
      saveState();
    }
  }
  const vendor = vendorsData.vendors.find((x) => x.vendor_code === state.vendorCode);
  const profile = profilesByCode[state.vendorCode];

  let content;
  let afterRender = null;
  if (route === "overview") {
    content = vendor
      ? renderOverview({ rules, vendor, profile, period, stats: vendorsData.stats })
      : `<div class="empty-state">${t("error.vendor_missing")}</div>`;
  } else if (route === "rules") {
    content = renderRules({ rules, viewer: {
      city: vendor?.city ?? Object.keys(rules.level_lines.by_city)[0],
      seeAllCities: state.role !== "vendor",   // RM / 内部运营 / 主管理员看全部城市
    } });
  } else if (route === "performance" && vendor) {
    content = renderPerformance({ rules, vendor });
  } else if (route === "advice" && vendor) {
    content = renderAdvice({ rules, vendor, profile, period });
    afterRender = () => bindAdvice({ rules, vendor, period });
  } else if (route === "earnings" && vendor) {
    content = renderEarnings({ rules, vendor, period });
  } else if (route === "admin") {
    if (state.role !== "admin") {
      content = `<div class="empty-state"><p>${t("admin.denied")}</p></div>`;
    } else {
      content = renderAdmin();
      afterRender = () => bindAdmin({ rules, vendorsData, profilesByCode, onRulesSaved, period });
    }
  } else if (route === "portfolio") {
    if (state.role === "vendor") {
      content = `<div class="empty-state"><p>${t("bench.denied")}</p></div>`;
    } else {
      const isAll = state.role !== "rm";
      const roster = visibleVendors();   // RM 视角已按名下过滤（铁律 7）
      content = renderPortfolio({
        rules, roster, profilesByCode, period, isAll,
        scopeLabel: isAll ? t("portfolio.scope_all") : t("portfolio.scope_rm", { name: state.rmName }),
      });
      afterRender = () => bindPortfolio((code) => {
        state.vendorCode = code;
        saveState();
        location.hash = "#/overview";   // 点行 → 跳该商总览
      });
    }
  } else if (route === "benchmark") {
    // 按角色分开挂载：Vendor 视角绝不渲染标杆组件（铁律 7）
    if (state.role === "vendor" || !vendor) {
      content = `<div class="empty-state"><p>${t("bench.denied")}</p></div>`;
    } else {
      content = renderBenchmark({
        rules, vendorsData, vendor, profilesByCode,
        rmName: state.role === "rm" ? state.rmName : null,
      });
    }
  } else {
    content = `
    <div class="empty-state">
      <p class="fw" style="font-size:18px">${t("page.wip")}</p>
      <p class="faint">${t("page.wip_hint")}</p>
      <p class="action"><a class="btn" href="#/">${t("page.back_overview")}</a></p>
    </div>`;
  }

  app.innerHTML = shell(route, content, { vendor, profile });
  bindShell();
  afterRender?.();
  window.scrollTo(0, 0);
}

function shell(route, content, { profile }) {
  const draftBanner = rules.status === "draft"
    ? `<div class="draft-banner" role="status">${t("banner.draft")}</div>` : "";
  const weeklyBanner = period?.type === "weekly"
    ? `<div class="draft-banner weekly" role="status">${t("banner.weekly_trial")}</div>` : "";

  const navItems = NAV_FOR_ROLE[state.role].map((r) => {
    const href = r === "overview" ? "#/" : `#/${r}`;
    const current = route === r ? ' aria-current="page"' : "";
    return `<a href="${href}"${current}>${t(`nav.${r}`)}</a>`;
  }).join("");

  const roleOptions = ["vendor", "rm", "ops", "admin"]
    .map((r) => `<option value="${r}"${state.role === r ? " selected" : ""}>${t(`role.${r}`)}</option>`)
    .join("");
  const rmSelect = state.role === "rm"
    ? `<label class="faint" for="rm-select">${t("switcher.rm_label")}</label>
       <select id="rm-select" aria-label="${t("switcher.rm_label")}">${
         rmList.map((r) => `<option value="${r}"${state.rmName === r ? " selected" : ""}>${r}</option>`).join("")}</select>`
    : "";
  // 上线模式：身份由数据库决定，不给切换；只显示当前角色与退出入口
  const identityControls = AUTH_ENABLED
    ? `<span class="chip">${t(`role.${state.role}`)}</span>
       <button type="button" class="scope-btn" id="signout-btn">${t("login.signout")}</button>`
    : `<label class="faint" for="role-select">${t("role.label")}</label>
       <select id="role-select" aria-label="${t("role.label")}">${roleOptions}</select>
       ${rmSelect}`;
  // 内部角色（主管理员/内部运营）看全部 100+ 家：下拉里补上 vendor_code 并提供搜索框。
  // 必要性：102 家里有 63 家的「供应商名称」是法人姓名，与 vendor_code 毫无字面关系
  //（多数商的显示名是法人姓名，与商号毫无字面关系），只按显示名根本找不到。
  const internalRole = state.role === "admin" || state.role === "ops";
  vendorPickList = visibleVendors().map((v) => {
    const name = profilesByCode[v.vendor_code]?.display_name ?? v.vendor_code;
    return {
      code: v.vendor_code,
      city: v.city,
      label: internalRole ? `${name} · ${v.city} · ${v.vendor_code}` : `${name} · ${v.city}`,
      haystack: normalizeSearch(`${name} ${v.vendor_code} ${v.city}`),
    };
  });
  const vendorOptions = vendorOptionsHTML(vendorPickList);
  const vendorSearch = internalRole
    ? `<input type="search" id="vendor-search" class="vendor-search"
              placeholder="${t("switcher.vendor_search")}" aria-label="${t("switcher.vendor_search")}"
              value="${vendorFilter.replace(/"/g, "&quot;")}">`
    : "";

  // 两个评定期下拉互斥：选月度则周度显示占位，反之同理。月度=正式评级，周度=试算快照
  const isWeekly = state.periodType === "weekly";
  const monthOptions = [
    `<option value=""${isWeekly ? " selected" : ""}>${t("period.none")}</option>`,
    ...periodsIndex.monthly.map((e) => {
      const m = Number((e.id.split("-")[1] ?? "").replace(/^0/, ""));
      const sel = !isWeekly && e.id === state.periodId ? " selected" : "";
      return `<option value="${e.id}"${sel}>${t("period.month_label", { m })}</option>`;
    }),
  ].join("");
  const weekOptions = [
    `<option value=""${!isWeekly ? " selected" : ""}>${t("period.none")}</option>`,
    ...periodsIndex.weekly.map((e) => {
      const sel = isWeekly && e.id === state.periodId ? " selected" : "";
      const label = e.range ? t("period.weekly_label", { wk: e.week_label, range: e.range }) : e.week_label;
      return `<option value="${e.id}"${sel}>${label}</option>`;
    }),
  ].join("");

  const strip = `${"DIDI ALIANZA · ".repeat(60)}`;

  return `
  <header class="site-header">
    <div class="inner">
      <div class="logo">
        <div class="logo-mark" aria-hidden="true">D</div>
        <div>
          <div class="logo-text">DiDi <span class="alianza">Alianza</span></div>
          <div class="logo-sub">${t("app.subtitle")}</div>
        </div>
      </div>
      <div class="identity">
        ${identityControls}
        <label class="faint" for="vendor-select">${t("switcher.vendor_label")}</label>
        ${vendorSearch}
        <select id="vendor-select" aria-label="${t("switcher.vendor_label")}"${
          AUTH_ENABLED && state.role === "vendor" ? " disabled" : ""}>${vendorOptions}</select>
        <span class="period-group">
          <label class="faint" for="month-select">${t("period.monthly_select")}</label>
          <select id="month-select" aria-label="${t("period.monthly_select")}">${monthOptions}</select>
          <label class="faint" for="week-select">${t("period.weekly_select")}</label>
          <select id="week-select" aria-label="${t("period.weekly_select")}">${weekOptions}</select>
        </span>
        <span class="lang-switch" role="group" aria-label="${t("lang.switch")}">
          ${LANGS.map((l) => `<button type="button" class="lang-btn${
            l === currentLang() ? " active" : ""}" data-lang="${l}" aria-pressed="${l === currentLang()}">${
            l.toUpperCase()}</button>`).join("")}
        </span>
      </div>
    </div>
  </header>
  ${draftBanner}${weeklyBanner}
  <nav class="site-nav" aria-label="main">
    <div class="inner">${navItems}</div>
  </nav>
  <main>${content}</main>
  <footer class="site-footer">
    <div class="notes">
      ${t("footer.disclaimer", { period: period.label })}
    </div>
    <div class="footer-strip" aria-hidden="true">${strip}</div>
  </footer>`;
}

function bindShell() {
  document.getElementById("role-select")?.addEventListener("change", (e) => {
    state.role = e.target.value;
    saveState();
    render();
  });
  document.getElementById("vendor-select")?.addEventListener("change", (e) => {
    state.vendorCode = e.target.value;
    saveState();
    render();
  });
  document.getElementById("rm-select")?.addEventListener("change", (e) => {
    state.rmName = e.target.value;
    saveState();
    render();
  });
  // 搜索只重建 <select> 的选项，不整页重渲染——否则每敲一个字就丢焦点
  const searchEl = document.getElementById("vendor-search");
  searchEl?.addEventListener("input", () => {
    vendorFilter = searchEl.value;
    const sel = document.getElementById("vendor-select");
    if (sel) sel.innerHTML = vendorOptionsHTML(vendorPickList);
  });
  // 回车：若只剩一个匹配项，直接选中它（常用：粘 vendor_code → 回车）
  searchEl?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const sel = document.getElementById("vendor-select");
    const opts = [...(sel?.options ?? [])].filter((o) => o.value);
    if (opts.length === 1) {
      state.vendorCode = opts[0].value;
      saveState();
      render();
      document.getElementById("vendor-search")?.focus();
    }
  });
  document.querySelectorAll("[data-lang]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.dataset.lang === currentLang()) return;
      state.lang = btn.dataset.lang;
      saveState();
      await initI18n(state.lang);
      period = normalizePeriod(periodEntry(), t);  // 评定期标签由 i18n 生成，换语言要重算
      render();
    });
  });
  document.getElementById("signout-btn")?.addEventListener("click", () => {
    signOut();
    localStorage.removeItem(STATE_KEY);
    location.reload();
  });
  document.getElementById("month-select")?.addEventListener("change", (e) => {
    if (!e.target.value) return render(); // 选回占位不做切换
    switchPeriod("monthly", e.target.value);
  });
  document.getElementById("week-select")?.addEventListener("change", (e) => {
    if (!e.target.value) return render();
    switchPeriod("weekly", e.target.value);
  });
}

boot();
