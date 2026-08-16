// 登录页（阶段二）：仅当数据源为 supabase 且未登录时渲染。
// 账号由主管理员分配（需求文档 3.x）；页面不提供注册、不提供密码重置自助入口。
// 输入的凭据直接交给 Supabase Auth，前端不存密码、只存返回的 token。

import { t } from "../i18n.js";
import { signIn } from "../supabase.js";

export function renderLogin() {
  return `
  <div class="login-wrap">
    <form class="card login-card" id="login-form" autocomplete="on">
      <div class="logo" style="margin-bottom:22px">
        <div class="logo-mark" aria-hidden="true">D</div>
        <div>
          <div class="logo-text">DiDi <span class="alianza">Alianza</span></div>
          <div class="logo-sub">${t("app.subtitle")}</div>
        </div>
      </div>
      <h2 class="fw" style="font-size:20px;margin-bottom:6px">${t("login.title")}</h2>
      <p class="faint small" style="margin-bottom:20px">${t("login.hint")}</p>
      <label class="field" style="margin-bottom:14px">
        <span class="faint small">${t("login.email")}</span>
        <input type="email" id="login-email" name="email" autocomplete="username" required>
      </label>
      <label class="field" style="margin-bottom:20px">
        <span class="faint small">${t("login.password")}</span>
        <input type="password" id="login-password" name="password" autocomplete="current-password" required>
      </label>
      <button type="submit" class="btn" style="width:100%" id="login-submit">${t("login.submit")}</button>
      <p id="login-error" class="small" style="color:var(--alert);margin-top:12px;min-height:18px"></p>
      <p class="faint small" style="margin-top:8px">${t("login.contact")}</p>
    </form>
  </div>`;
}

export function bindLogin(onSuccess) {
  const form = document.getElementById("login-form");
  const errEl = document.getElementById("login-error");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("login-submit");
    btn.disabled = true;
    errEl.textContent = "";
    try {
      await signIn(
        document.getElementById("login-email").value.trim(),
        document.getElementById("login-password").value
      );
      await onSuccess();
    } catch (err) {
      errEl.textContent = t(err.code === "auth.bad_credentials" ? "login.bad_credentials" : "login.failed");
      btn.disabled = false;
    }
  });
}
