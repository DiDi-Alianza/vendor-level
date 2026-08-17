# 商分级 · Vendor 等级自助查询网站

DiDi Alianza 墨西哥 Vendor（配送商）等级体系的自助查询站点。供应商登录后可以看到三件事：
**我是什么等级、我差在哪、我还能多挣多少**；RM 与内部运营另有全盘视图。

线上（当前托管在 GitHub Pages）：<https://didi-alianza.github.io/vendor-level/>

> 交接给公司 IT 的完整说明见 **[HANDOVER-IT.md](HANDOVER-IT.md)**，包含架构、数据模型、
> 行级安全策略、迁移步骤与迁移过程中**绝对不能破坏的几条不变量**。

---

## 技术栈

| 项 | 选择 | 理由 |
|---|---|---|
| 前端 | 原生 ES Modules + CSS 自定义属性，**零依赖、零构建** | 开发环境 npm registry 不可达；无构建步骤意味着改完直接发，也便于交接 |
| 运行时（脚本） | Bun 1.3+ | 内置测试与 TypeScript 支持，脚本与浏览器共用同一份引擎代码 |
| 数据与认证 | Supabase（PostgREST + Auth + **行级安全 RLS**） | 隔离在数据库层强制，不依赖前端过滤 |
| 数据提取 | Python 3.10 + openpyxl（一次性脚本） | 源数据是 xlsx，产物落 `data/*.json`，JS 端只读 JSON |

## 目录

```
index.html          入口（零构建，直接由静态服务器提供）
src/
  app.js            路由与外壳（角色、期次、语言切换）
  data.js           数据接入层 —— local(JSON) / supabase 在此切换，页面代码不感知来源
  supabase.js       极简 Supabase 客户端（Auth + PostgREST，零依赖）
  engine/           计分引擎（纯函数，浏览器与脚本共用同一份）
    rules.js        档位判定、综合分、等级、灵活分、激励估算
    protection.js   新商保护期（15 号切分规则）
    ranking.js      排名与分布（导入时预计算与页面消费共用，杜绝口径漂移）
    advice.js       提分分析（下一档、性价比排序）
  views/            各页面（纯函数：数据进、HTML 字符串出）
  i18n/             中 / 西 / 英语言包（中文为母本，缺译回退中文）
scripts/            数据提取、导入、校验、测试、发布
supabase/           数据库迁移 SQL（建表 + 逐表 RLS 策略）
tests/              bun test 单元测试
```

**本仓库不含任何业务数据**：每商评级与得分、商名单、RM 归属、还款信用与红线名单
一律不入库（`data/` 在 `.gitignore`）。线上数据全部由 Supabase 按登录身份 + RLS 下发。

## 本地运行

```bash
bun scripts/serve.js          # 起静态服务器（默认 8017）
```

数据源由 `src/data.js` 的 `SOURCE` 决定：

- `"local"` —— 读 `data/*.json`，**无需登录**，用于开发与演示（数据文件需另行取得）
- `"supabase"` —— 登录 + RLS，线上形态

## 回归套件（改动后必跑）

```bash
bun scripts/validate_rules.js   # 权重和、changelog 声称的变更是否属实、i18n 覆盖、档位方向自洽
bun scripts/recalc.js           # 逐商比对：六项得分 / 综合分 / 等级，须 102/102 全对
bun test                        # 引擎与保护期单元测试
bun scripts/test_rls.js         # 越权测试：匿名与跨商请求必须返回 0 行
bun scripts/test_roles.js       # 四角色适配器验收：每个角色实际拿到的数据是否符合可见范围
bun scripts/render_check.js     # 全站渲染自检：每期 × 每商 × 每页 × 三语，扫坏值与漏译
```

前四项管「算得对不对」，`render_check` 管「页面渲不渲得出来」，`test_roles` 管「每个角色
看到的对不对」——三类问题互不覆盖，缺一不可。

## 发布

```bash
bash scripts/publish_site.sh    # 推送到 gh-pages 分支（只含 index.html + src/）
```

**发布面必须最小化**：GitHub Pages 站点 URL 是公开的（即使仓库私有），所以只发布站点
真正需要的 26 个文件，脚本、迁移 SQL、测试一律不发布。脚本内置两道自查，产物里一旦
出现内部文件或 Secret key 立即中止。

## 核心设计约束

1. **规则是数据，不是代码。** `data/rules.json` 是等级规则的唯一事实来源。代码里出现任何
   权重、阈值、分数线、单价的字面值都算 bug。引擎遍历 `indicators` 数组通用实现，
   不为单个指标写专用分支——分数线还会随市场校准。
2. **引擎只有一份。** `src/engine/` 同时被浏览器、`recalc.js` 校验脚本和单元测试引用，
   杜绝「脚本算的和页面算的不一致」。
3. **隔离靠数据库，不靠前端。** 前端过滤只是显示效果。真正的隔离是 Supabase 行级安全，
   与托管平台无关。
4. **派生值实时计算，不读存储标记。** 布尔标记（如是否被规模门槛拦截）一律由引擎按规则现算，
   存储值仅供交叉校验——源表备注列存在跨版本继承污染的先例。
5. **数据对不上就报告，不静默处理。** 缺失值不当 0，缺失日期不默认为「已过期」。
