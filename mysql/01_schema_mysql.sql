-- =============================================================================
-- 商分级 Vendor 等级查询网站 · MySQL 表结构
--
-- 由 supabase/migration_001~003（PostgreSQL）翻译而来，已合并为最终状态，
-- 不需要按顺序跑三个迁移。幂等：全部 CREATE TABLE IF NOT EXISTS。
--
-- 要求 MySQL 8.0.16+（用到 JSON 类型与 CHECK 约束）。
-- 字符集 utf8mb4：商编码与显示名含西语重音字符（ENVÍAGUIA、MONDRAGÓN、RÁPIDITOS）。
--
-- ⚠️⚠️ 迁移最关键的一点，请先读 README-MYSQL.md 的「隔离」一节：
--   原方案的数据隔离**完全由 PostgreSQL 的行级安全（RLS）在数据库层强制**——
--   Vendor 即使手动构造请求，数据库也只返回他自己那一行。
--   **MySQL 没有行级安全。** 这些表建完之后隔离能力为零：任何能连库的人都能读全表。
--   隔离必须在应用层重新实现，并收敛在唯一的数据访问入口。
--   本文件末尾提供一组视图，作为「第二道防线」的参考实现。
-- =============================================================================

SET NAMES utf8mb4;

-- ---------- 账号 → 角色映射 ----------
-- 原表 user_id 外键指向 Supabase 的 auth.users。迁到公司环境请改成公司认证体系的用户标识
-- （工号 / SSO subject / 内部 user_id 均可），类型按实际调整。
CREATE TABLE IF NOT EXISTS vg_user_roles (
  user_id     VARCHAR(64)  NOT NULL,
  role        VARCHAR(16)  NOT NULL,
  vendor_code VARCHAR(64)  NULL,
  rm_name     VARCHAR(64)  NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_vg_user_roles_role (role),
  CONSTRAINT vg_role_chk          CHECK (role IN ('vendor','rm','ops','admin')),
  -- vendor 必须绑商编码、rm 必须绑 RM 姓名：绑不上就是个看不到任何数据的空账号
  CONSTRAINT vg_vendor_needs_code CHECK (role <> 'vendor' OR vendor_code IS NOT NULL),
  CONSTRAINT vg_rm_needs_name     CHECK (role <> 'rm'     OR rm_name     IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='账号与角色绑定；role 决定可见范围';

-- ---------- 商档案 ----------
CREATE TABLE IF NOT EXISTS vg_vendor_profile (
  vendor_code      VARCHAR(64)  NOT NULL,
  display_name     VARCHAR(128) NULL COMMENT '多为法人姓名，与商号无字面关系；页面统一显示 vendor_code',
  city             VARCHAR(32)  NULL,
  rm_name          VARCHAR(64)  NULL COMMENT '为空=未分配 RM（现有 4 家），不要就近分配',
  first_order_date DATE         NULL COMMENT '保护期起算基准；为空须显示「未知，待补数据」，不得默认为已过期',
  active_status    VARCHAR(16)  NULL,
  PRIMARY KEY (vendor_code),
  KEY idx_vg_profile_rm (rm_name),
  KEY idx_vg_profile_city (city)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 每期评级结果（页面主表） ----------
CREATE TABLE IF NOT EXISTS vg_vendor_scores (
  period            VARCHAR(16)  NOT NULL COMMENT '月度如 2026-07，周度如 2026-W32',
  vendor_code       VARCHAR(64)  NOT NULL,
  period_type       VARCHAR(16)  NOT NULL DEFAULT 'monthly',
  city              VARCHAR(32)  NOT NULL,
  level             VARCHAR(4)   NOT NULL,
  level_official_v1 VARCHAR(4)   NULL COMMENT '旧体系同期等级，用于对比',
  level_change      VARCHAR(4)   NULL COMMENT '↑ / ↓ / NULL',
  total_score       DECIMAL(6,2) NOT NULL,
  redline           TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '月度：欠款红线是否已触发',
  redline_week_hit  TINYINT(1)   NULL COMMENT '周度：本周是否命中（单周命中≠触发）',
  indicators        JSON         NOT NULL COMMENT '六项指标的值/得分/权重/档位',
  -- 名次与百分位必须在导入时预计算写入本行：
  -- 原方案下 Vendor 只能读到自己 1 行，页面无法遍历全网算名次
  rank_all   INT NULL,
  pct_all    INT NULL,
  rank_city  INT NULL,
  pct_city   INT NULL,
  rank_level INT NULL COMMENT '同等级全网排名；对商只披露等级内与本城名次，不给总家数',
  PRIMARY KEY (period, vendor_code),
  KEY idx_vg_scores_period_type (period, period_type),
  KEY idx_vg_scores_vendor (vendor_code),
  KEY idx_vg_scores_level (period, level),
  CONSTRAINT vg_scores_ptype_chk CHECK (period_type IN ('monthly','weekly'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 灵活分流水（加分/扣分分开记，便于审计） ----------
CREATE TABLE IF NOT EXISTS vg_flex_adjustments (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  period      VARCHAR(16)  NOT NULL,
  vendor_code VARCHAR(64)  NOT NULL,
  type        VARCHAR(24)  NOT NULL,
  value       DECIMAL(6,2) NOT NULL,
  reason      VARCHAR(255) NOT NULL COMMENT '扣分必须附可对外说明的原因',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vg_flex_period_vendor (period, vendor_code),
  CONSTRAINT vg_flex_type_chk CHECK (type IN ('activity_bonus','penalty'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 分布与等级聚合（无身份信息，任何登录角色可读） ----------
CREATE TABLE IF NOT EXISTS vg_score_distribution (
  period    VARCHAR(16) NOT NULL,
  scope     VARCHAR(32) NOT NULL COMMENT 'all 或城市名',
  bin_start INT         NOT NULL,
  cnt       INT         NOT NULL,
  PRIMARY KEY (period, scope, bin_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vg_level_counts (
  period VARCHAR(16) NOT NULL,
  scope  VARCHAR(32) NOT NULL,
  level  VARCHAR(4)  NOT NULL,
  cnt    INT         NOT NULL,
  PRIMARY KEY (period, scope, level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 期次索引 ----------
CREATE TABLE IF NOT EXISTS vg_periods (
  period       VARCHAR(16) NOT NULL,
  type         VARCHAR(16) NOT NULL DEFAULT 'monthly',
  weeks        VARCHAR(64) NULL,
  week_label   VARCHAR(32) NULL,
  date_range   VARCHAR(64) NULL,
  month        VARCHAR(16) NULL,
  days         INT         NULL COMMENT '月度=当月自然日数，周度=7',
  vendor_count INT         NULL,
  disclaimer   TINYINT(1)  NOT NULL DEFAULT 0 COMMENT '周度=1：试算快照，非正式评级',
  PRIMARY KEY (period),
  CONSTRAINT vg_periods_type_chk CHECK (type IN ('monthly','weekly'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 规则：公示部分（登录可读）与内部部分（仅主管理员） ----------
CREATE TABLE IF NOT EXISTS vg_rules_public (
  id             BIGINT      NOT NULL AUTO_INCREMENT,
  version        VARCHAR(16) NOT NULL,
  status         VARCHAR(16) NOT NULL COMMENT 'draft / active / superseded',
  effective_from VARCHAR(16) NOT NULL,
  body           JSON        NOT NULL COMMENT '等级规则唯一事实来源的公示部分',
  created_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vg_rules_internal (
  id         BIGINT   NOT NULL AUTO_INCREMENT,
  body       JSON     NOT NULL COMMENT '备选分数线、SA 占比目标等，绝不可下发给 Vendor',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vg_rules_history (
  id       BIGINT       NOT NULL AUTO_INCREMENT,
  saved_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  body     JSON         NOT NULL,
  reason   VARCHAR(255) NULL,
  author   VARCHAR(64)  NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================================
-- 隔离参考实现（第二道防线）
--
-- MySQL 没有行级安全，下面用会话变量表达原 RLS 的可见范围。
-- 用法：每个请求在**同一条连接上**先设身份，再查视图：
--     SET @vg_user_id = '<当前登录用户标识>';
--     SELECT * FROM v_vg_vendor_scores WHERE period = '2026-07';
--
-- ⚠️ 三个注意事项：
--   1. 用连接池时必须保证「设变量」与「查询」在同一条连接上，且请求结束后清理，
--      否则会串号——这是这套方案最容易出事的地方。
--   2. 视图只是防线之一，**主防线仍应是应用层唯一的数据访问入口**。
--   3. 若公司平台已有成熟的数据权限中间件，优先用它；这些视图可只作可见范围的对照参考。
-- =============================================================================

-- ---- 身份读取：存储函数（视图里不能直接引用 @变量，必须经函数） ----
-- MySQL 的 CREATE VIEW 明确禁止引用用户变量，所以这里照原 PostgreSQL 版的结构
-- 先定义三个身份函数，视图再调它们。声明 READS SQL DATA 以便开启 binlog 时也能创建。

DROP FUNCTION IF EXISTS vg_my_role;
DROP FUNCTION IF EXISTS vg_my_vendor;
DROP FUNCTION IF EXISTS vg_my_rm;

DELIMITER $$

CREATE FUNCTION vg_my_role() RETURNS VARCHAR(16)
  READS SQL DATA
  NOT DETERMINISTIC
  SQL SECURITY INVOKER
BEGIN
  DECLARE v VARCHAR(16);
  SELECT role INTO v FROM vg_user_roles WHERE user_id = @vg_user_id LIMIT 1;
  RETURN v;
END$$

CREATE FUNCTION vg_my_vendor() RETURNS VARCHAR(64)
  READS SQL DATA
  NOT DETERMINISTIC
  SQL SECURITY INVOKER
BEGIN
  DECLARE v VARCHAR(64);
  SELECT vendor_code INTO v FROM vg_user_roles WHERE user_id = @vg_user_id LIMIT 1;
  RETURN v;
END$$

CREATE FUNCTION vg_my_rm() RETURNS VARCHAR(64)
  READS SQL DATA
  NOT DETERMINISTIC
  SQL SECURITY INVOKER
BEGIN
  DECLARE v VARCHAR(64);
  SELECT rm_name INTO v FROM vg_user_roles WHERE user_id = @vg_user_id LIMIT 1;
  RETURN v;
END$$

DELIMITER ;

-- ---- 视图：把原 RLS 各表的可见范围逐条翻译过来 ----

-- 评级结果：vendor=自己｜rm=名下 ∪ 全部 S 级｜ops/admin=全部
CREATE OR REPLACE VIEW v_vg_vendor_scores AS
  SELECT s.*
  FROM vg_vendor_scores s
  LEFT JOIN vg_vendor_profile p ON p.vendor_code = s.vendor_code
  WHERE vg_my_role() IN ('admin','ops')
     OR (vg_my_role() = 'vendor' AND s.vendor_code = vg_my_vendor())
     OR (vg_my_role() = 'rm' AND (p.rm_name = vg_my_rm() OR s.level = 'S'));

-- 商档案：vendor=自己｜rm=名下 ∪ S 级｜ops/admin=全部
CREATE OR REPLACE VIEW v_vg_vendor_profile AS
  SELECT p.*
  FROM vg_vendor_profile p
  WHERE vg_my_role() IN ('admin','ops')
     OR (vg_my_role() = 'vendor' AND p.vendor_code = vg_my_vendor())
     OR (vg_my_role() = 'rm' AND (p.rm_name = vg_my_rm()
         OR EXISTS (SELECT 1 FROM vg_vendor_scores s
                    WHERE s.vendor_code = p.vendor_code AND s.level = 'S')));

-- 灵活分：vendor=自己｜rm=名下｜ops/admin=全部
CREATE OR REPLACE VIEW v_vg_flex_adjustments AS
  SELECT f.*
  FROM vg_flex_adjustments f
  LEFT JOIN vg_vendor_profile p ON p.vendor_code = f.vendor_code
  WHERE vg_my_role() IN ('admin','ops')
     OR (vg_my_role() = 'vendor' AND f.vendor_code = vg_my_vendor())
     OR (vg_my_role() = 'rm' AND p.rm_name = vg_my_rm());

-- 内部规则（备选分数线、SA 占比目标）：仅主管理员
CREATE OR REPLACE VIEW v_vg_rules_internal AS
  SELECT r.* FROM vg_rules_internal r
  WHERE vg_my_role() = 'admin';

-- ---- 自检：三个角色分别应看到多少行 ----
-- 期望：vendor=1 行；rm=名下 ∪ S 级；ops/admin=全部。对不上说明视图或绑定有问题。
--
-- SET @vg_user_id = '<某个 vendor 的 user_id>';
-- SELECT COUNT(*) FROM v_vg_vendor_scores WHERE period = '2026-07';   -- 应为 1
--
-- SET @vg_user_id = '<某个 ops 的 user_id>';
-- SELECT COUNT(*) FROM v_vg_vendor_scores WHERE period = '2026-07';   -- 应为 102
