// 极简 Supabase 客户端（零依赖，npm 不可达故不用官方 SDK）。
// 只用两个公开 REST 接口：Auth（/auth/v1）与 PostgREST（/rest/v1）。
// 安全模型：前端只持 Publishable key（设计上就是公开的，随页面下发）；
// 能读到什么完全由数据库 RLS 决定。Secret key 绝不出现在前端。

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const SESSION_KEY = "alianza_supabase_session";

let session = null;
try {
  session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
} catch { session = null; }

function persist(s) {
  session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

export function currentSession() {
  return session;
}

export function isSignedIn() {
  return !!session?.access_token;
}

/** 当前登录用户的 uid。旧版 session 没存过 → 回查一次 /auth/v1/user 并补写 */
export async function currentUserId() {
  const s = await ensureFresh();
  if (!s) return null;
  if (s.user_id) return s.user_id;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${s.access_token}` },
  });
  if (!res.ok) return null;
  const u = await res.json();
  persist({ ...s, user_id: u.id });
  return u.id ?? null;
}

/** 邮箱 + 密码登录。失败抛出带 code 的错误，由 UI 层翻译成人话 */
export async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = new Error(`sign in failed: ${res.status}`);
    err.code = res.status === 400 ? "auth.bad_credentials" : "auth.failed";
    throw err;
  }
  const body = await res.json();
  persist({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
    email: body.user?.email ?? email,
    // 必须存 uid：主管理员的 RLS 允许读 vg_user_roles 全表（要管账号），
    // 取身份时若不按 uid 过滤，admin 可能被判成别人的角色（2026-08-16 实测命中）
    user_id: body.user?.id ?? null,
  });
  return session;
}

export function signOut() {
  persist(null);
}

/** access_token 快过期时静默续期；续期失败则登出（让 UI 回登录页，不静默展示空数据） */
async function ensureFresh() {
  if (!session) return null;
  if (Date.now() < session.expires_at - 60_000) return session;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) { persist(null); return null; }
  const body = await res.json();
  persist({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
    email: session.email,
    user_id: body.user?.id ?? session.user_id ?? null,
  });
  return session;
}

/**
 * PostgREST 查询。返回行数组。
 * 注意：RLS 是静默过滤——查不到不等于报错。调用方必须自行判断"空结果"的业务含义，
 * 不能把空当成"数据不存在"（可能是无权限）。
 */
export async function select(table, query = "") {
  const s = await ensureFresh();
  if (!s) {
    const err = new Error("not signed in");
    err.code = "auth.required";
    throw err;
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ""}`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${s.access_token}` },
  });
  if (!res.ok) {
    const err = new Error(`select ${table}: ${res.status} ${await res.text()}`);
    err.code = res.status === 401 ? "auth.required" : "data.query_failed";
    throw err;
  }
  return res.json();
}
