-- =============================================================================
-- 迁移 002：支持周度评定期（月度=正式评级 / 周度=试算快照）
-- 只 ALTER 自己的 vg_* 表，零接触 PK 既有对象。幂等，可重跑。
-- 依据：data/periods.json 的形状（scripts/build_periods_index.js 生成）
-- =============================================================================

-- vg_periods 升级为 periods 索引的库内等价物
alter table public.vg_periods add column if not exists type         text not null default 'monthly';
alter table public.vg_periods add column if not exists week_label   text;
alter table public.vg_periods add column if not exists date_range   text;
alter table public.vg_periods add column if not exists month        text;
alter table public.vg_periods add column if not exists days         int;
alter table public.vg_periods add column if not exists vendor_count int;
alter table public.vg_periods add column if not exists disclaimer   boolean not null default false;
alter table public.vg_periods alter column weeks drop not null;   -- 周度期没有 weeks 跨度串

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vg_periods_type_chk') then
    alter table public.vg_periods add constraint vg_periods_type_chk check (type in ('monthly','weekly'));
  end if;
end $$;

-- 评级表标注期类型，便于按类型筛选（PK 仍是 period+vendor_code）
alter table public.vg_vendor_scores add column if not exists period_type text not null default 'monthly';
alter table public.vg_vendor_scores add column if not exists redline_week_hit boolean;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vg_vendor_scores_ptype_chk') then
    alter table public.vg_vendor_scores add constraint vg_vendor_scores_ptype_chk
      check (period_type in ('monthly','weekly'));
  end if;
end $$;

create index if not exists vg_vendor_scores_period_idx on public.vg_vendor_scores (period, period_type);

-- 聚合表同样按期存储（主键已含 period，无需改动）；确认 RLS 仍在（002 不改策略）
select c.relname, c.relrowsecurity as rls_on
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('vg_periods','vg_vendor_scores');
