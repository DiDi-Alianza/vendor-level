-- =============================================================================
-- 迁移 003：等级内排名列（rank_level）
-- 由来：2026-08-14 排名并入总览页，对商只给「等级内第几 + 本城第几」，不给总家数。
-- 名次必须由导入时预计算写入本行——Vendor 在 RLS 下只能读到自己 1 行，页面无法遍历全网算名次。
-- 只 ALTER 自己的 vg_* 表，零接触 PK。幂等可重跑。
-- =============================================================================

alter table public.vg_vendor_scores add column if not exists rank_level int;

comment on column public.vg_vendor_scores.rank_level is
  '同等级全网排名（competition ranking，灵活分调整后综合分降序）。由 scripts/supabase_import.js 用 src/engine/ranking.js 预计算写入。';

-- 确认 RLS 未受影响（ALTER 不改策略，此处仅回显以便留档）
select c.relname as tbl, c.relrowsecurity as rls_on,
       (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public' and c.relname = 'vg_vendor_scores';
