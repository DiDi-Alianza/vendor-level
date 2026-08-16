-- =============================================================================
-- 商分级 Vendor 等级查询网站 · Supabase 迁移 001：表结构 + RLS
-- 宿主：复用 DiDi-PK 项目（2026-08-13 用户拍板）。六条前提：
--   全表显式开 RLS ｜ 绝不碰 PK 现有表/策略/Auth ｜ 统一 vg_ 前缀 ｜
--   越权测试含匿名全表扫 ｜ service_role 不进前端 ｜ 设计先确认再执行
-- 本文件只创建 vg_* 新对象，不 ALTER/DROP/REVOKE 任何既有对象——对 PK 零影响。
-- 用法：SQL Editor 整段执行（幂等可重跑）。执行前需用户确认（前提 6）。
-- =============================================================================

-- ---------- 账号 → 角色映射 ----------
create table if not exists public.vg_user_roles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        text not null check (role in ('vendor','rm','ops','admin')),
  vendor_code text,
  rm_name     text,
  created_at  timestamptz not null default now(),
  constraint vg_vendor_needs_code check (role <> 'vendor' or vendor_code is not null),
  constraint vg_rm_needs_name     check (role <> 'rm' or rm_name is not null)
);

-- ---------- 业务表 ----------
create table if not exists public.vg_vendor_profile (
  vendor_code      text primary key,
  display_name     text,
  city             text,
  rm_name          text,
  first_order_date date,
  active_status    text
);

create table if not exists public.vg_vendor_scores (
  period            text not null,
  vendor_code       text not null,
  city              text not null,
  level             text not null,
  level_official_v1 text,
  level_change      text,
  total_score       numeric not null,
  redline           boolean not null default false,
  indicators        jsonb not null,
  rank_all  int, pct_all  int,
  rank_city int, pct_city int,
  primary key (period, vendor_code)
);

create table if not exists public.vg_flex_adjustments (
  id          bigint generated always as identity primary key,
  period      text not null,
  vendor_code text not null,
  type        text not null check (type in ('activity_bonus','penalty')),
  value       numeric not null,
  reason      text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.vg_score_distribution (
  period    text not null,
  scope     text not null,
  bin_start int  not null,
  cnt       int  not null,
  primary key (period, scope, bin_start)
);

create table if not exists public.vg_level_counts (
  period text not null,
  scope  text not null,
  level  text not null,
  cnt    int  not null,
  primary key (period, scope, level)
);

create table if not exists public.vg_periods (
  period text primary key,
  weeks  text not null
);

create table if not exists public.vg_rules_public (
  id             bigint generated always as identity primary key,
  version        text not null,
  status         text not null,
  effective_from text not null,
  body           jsonb not null,
  created_at     timestamptz not null default now()
);

create table if not exists public.vg_rules_internal (
  id         bigint generated always as identity primary key,
  body       jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.vg_rules_history (
  id       bigint generated always as identity primary key,
  saved_at timestamptz not null default now(),
  body     jsonb not null,
  reason   text,
  author   uuid references auth.users (id)
);

-- ---------- 身份辅助函数（vg_ 前缀避免与 PK 函数冲突；security definer 防策略递归） ----------
create or replace function public.vg_my_role() returns text
language sql stable security definer set search_path = public as
$$ select role from vg_user_roles where user_id = auth.uid() $$;

create or replace function public.vg_my_vendor() returns text
language sql stable security definer set search_path = public as
$$ select vendor_code from vg_user_roles where user_id = auth.uid() $$;

create or replace function public.vg_my_rm() returns text
language sql stable security definer set search_path = public as
$$ select rm_name from vg_user_roles where user_id = auth.uid() $$;

create or replace function public.vg_is_latest_s_vendor(code text) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from vg_vendor_scores s
     where s.vendor_code = code and s.level = 'S'
       and s.period = (select max(period) from vg_vendor_scores)
   ) $$;

create or replace function public.vg_is_my_roster(code text) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from vg_vendor_profile p
     where p.vendor_code = code and p.rm_name = vg_my_rm()
   ) $$;

revoke all on function public.vg_my_role(), public.vg_my_vendor(), public.vg_my_rm(),
  public.vg_is_latest_s_vendor(text), public.vg_is_my_roster(text) from anon;

-- ---------- RLS：全部 10 张表逐一显式启用（不依赖默认；Supabase 建表默认不开！） ----------
alter table public.vg_user_roles         enable row level security;
alter table public.vg_vendor_profile     enable row level security;
alter table public.vg_vendor_scores      enable row level security;
alter table public.vg_flex_adjustments   enable row level security;
alter table public.vg_score_distribution enable row level security;
alter table public.vg_level_counts       enable row level security;
alter table public.vg_periods            enable row level security;
alter table public.vg_rules_public       enable row level security;
alter table public.vg_rules_internal     enable row level security;
alter table public.vg_rules_history      enable row level security;

-- 匿名权限收口：仅撤我们自己的表（绝不动 schema 级/PK 表——PK 依赖匿名读！）
revoke all on public.vg_user_roles, public.vg_vendor_profile, public.vg_vendor_scores,
  public.vg_flex_adjustments, public.vg_score_distribution, public.vg_level_counts,
  public.vg_periods, public.vg_rules_public, public.vg_rules_internal, public.vg_rules_history
from anon;

-- ---------- 策略（全部仅 to authenticated；无策略即拒绝） ----------
-- vg_user_roles：看自己那行；admin 全量读写
drop policy if exists vg_user_roles_select on public.vg_user_roles;
create policy vg_user_roles_select on public.vg_user_roles for select to authenticated
  using (user_id = auth.uid() or vg_my_role() = 'admin');
drop policy if exists vg_user_roles_admin_write on public.vg_user_roles;
create policy vg_user_roles_admin_write on public.vg_user_roles for all to authenticated
  using (vg_my_role() = 'admin') with check (vg_my_role() = 'admin');

-- vg_vendor_scores：vendor=自己｜rm=名下+全部S（需求3.1）｜ops/admin=全部；写=admin
drop policy if exists vg_vendor_scores_select on public.vg_vendor_scores;
create policy vg_vendor_scores_select on public.vg_vendor_scores for select to authenticated
  using (
    vg_my_role() in ('admin','ops')
    or (vg_my_role() = 'vendor' and vendor_code = vg_my_vendor())
    or (vg_my_role() = 'rm' and (vg_is_my_roster(vendor_code) or level = 'S'))
  );
drop policy if exists vg_vendor_scores_admin_write on public.vg_vendor_scores;
create policy vg_vendor_scores_admin_write on public.vg_vendor_scores for all to authenticated
  using (vg_my_role() = 'admin') with check (vg_my_role() = 'admin');

-- vg_vendor_profile：vendor=自己行｜rm=名下+最新期S｜ops/admin=全部；写=admin
drop policy if exists vg_vendor_profile_select on public.vg_vendor_profile;
create policy vg_vendor_profile_select on public.vg_vendor_profile for select to authenticated
  using (
    vg_my_role() in ('admin','ops')
    or (vg_my_role() = 'vendor' and vendor_code = vg_my_vendor())
    or (vg_my_role() = 'rm' and (rm_name = vg_my_rm() or vg_is_latest_s_vendor(vendor_code)))
  );
drop policy if exists vg_vendor_profile_admin_write on public.vg_vendor_profile;
create policy vg_vendor_profile_admin_write on public.vg_vendor_profile for all to authenticated
  using (vg_my_role() = 'admin') with check (vg_my_role() = 'admin');

-- vg_flex_adjustments：vendor=自己｜rm=名下｜ops/admin=全部；写=admin
drop policy if exists vg_flex_select on public.vg_flex_adjustments;
create policy vg_flex_select on public.vg_flex_adjustments for select to authenticated
  using (
    vg_my_role() in ('admin','ops')
    or (vg_my_role() = 'vendor' and vendor_code = vg_my_vendor())
    or (vg_my_role() = 'rm' and vg_is_my_roster(vendor_code))
  );
drop policy if exists vg_flex_admin_write on public.vg_flex_adjustments;
create policy vg_flex_admin_write on public.vg_flex_adjustments for all to authenticated
  using (vg_my_role() = 'admin') with check (vg_my_role() = 'admin');

-- 聚合表 + periods + 公示规则：登录即可读（无身份信息）；写=admin
drop policy if exists vg_dist_select on public.vg_score_distribution;
create policy vg_dist_select on public.vg_score_distribution for select to authenticated using (true);
drop policy if exists vg_dist_admin_write on public.vg_score_distribution;
create policy vg_dist_admin_write on public.vg_score_distribution for all to authenticated
  using (vg_my_role() = 'admin') with check (vg_my_role() = 'admin');

drop policy if exists vg_lc_select on public.vg_level_counts;
create policy vg_lc_select on public.vg_level_counts for select to authenticated using (true);
drop policy if exists vg_lc_admin_write on public.vg_level_counts;
create policy vg_lc_admin_write on public.vg_level_counts for all to authenticated
  using (vg_my_role() = 'admin') with check (vg_my_role() = 'admin');

drop policy if exists vg_periods_select on public.vg_periods;
create policy vg_periods_select on public.vg_periods for select to authenticated using (true);
drop policy if exists vg_periods_admin_write on public.vg_periods;
create policy vg_periods_admin_write on public.vg_periods for all to authenticated
  using (vg_my_role() = 'admin') with check (vg_my_role() = 'admin');

drop policy if exists vg_rules_public_select on public.vg_rules_public;
create policy vg_rules_public_select on public.vg_rules_public for select to authenticated using (true);
drop policy if exists vg_rules_public_admin_write on public.vg_rules_public;
create policy vg_rules_public_admin_write on public.vg_rules_public for all to authenticated
  using (vg_my_role() = 'admin') with check (vg_my_role() = 'admin');

-- vg_rules_internal / vg_rules_history：仅 admin（备选线、SA 目标、定线痕迹）
drop policy if exists vg_rules_internal_admin on public.vg_rules_internal;
create policy vg_rules_internal_admin on public.vg_rules_internal for all to authenticated
  using (vg_my_role() = 'admin') with check (vg_my_role() = 'admin');
drop policy if exists vg_rules_history_admin on public.vg_rules_history;
create policy vg_rules_history_admin on public.vg_rules_history for all to authenticated
  using (vg_my_role() = 'admin') with check (vg_my_role() = 'admin');
