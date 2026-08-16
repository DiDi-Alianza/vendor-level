// 生成 src/config.js（bun scripts/build_config.js）
// 只写入两个"设计上公开"的值：项目 URL + Publishable key（随页面下发，本身无权限，一切靠 RLS）。
// Secret key 绝不写入——它只存在于 gitignored 的 scripts/.supabase_secrets.json。

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const s = JSON.parse(readFileSync(join(SITE, "scripts", ".supabase_secrets.json"), "utf-8"));

if (!s.url || !s.anon_key) {
  console.error("secrets 缺少 url 或 anon_key（Publishable key）");
  process.exit(1);
}
if (/^sb_secret_|service_role/.test(s.anon_key)) {
  console.error("拒绝写入：anon_key 位置放的像是 Secret key，绝不能进前端");
  process.exit(1);
}

const body = `// 由 scripts/build_config.js 生成。这两个值设计上就是公开的：
// Publishable key 随页面下发给任何访客，它本身没有任何权限——
// 能读到什么完全由 Supabase 行级安全（RLS）决定。Secret key 绝不出现在此文件。
export const SUPABASE_URL = ${JSON.stringify(s.url)};
export const SUPABASE_PUBLISHABLE_KEY = ${JSON.stringify(s.anon_key)};
`;
writeFileSync(join(SITE, "src", "config.js"), body, "utf-8");
console.log(`✓ src/config.js 已生成（url=${s.url}，key 前缀=${s.anon_key.slice(0, 16)}…）`);
