// 创建测试账号并绑定角色（bun scripts/supabase_setup_users.js）。幂等：已存在则跳过创建、仍刷新角色。
// 5 个测试账号覆盖四种角色 + 越权对照组；正式 Vendor 账号发放属后续步骤（主管理员批量创建）。

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const secrets = JSON.parse(readFileSync(join(SITE, "scripts", ".supabase_secrets.json"), "utf-8"));
const vendorsData = JSON.parse(readFileSync(join(SITE, "data", "vendors_2026_07.json"), "utf-8"));
const profileData = JSON.parse(readFileSync(join(SITE, "data", "vendor_profile.json"), "utf-8"));

const HEADERS = {
  apikey: secrets.service_role_key,
  Authorization: `Bearer ${secrets.service_role_key}`,
  "Content-Type": "application/json",
};

// 越权测试需要两家不同 Vendor + 一位真实 RM
const vendorA = vendorsData.vendors[0].vendor_code;
const vendorB = vendorsData.vendors[1].vendor_code;
const rmName = profileData.profiles.find((p) => p.rm)?.rm;

const USERS = [
  { email: "test-admin@alianza-demo.example.com", role: "admin" },
  { email: "test-ops@alianza-demo.example.com", role: "ops" },
  { email: "test-rm@alianza-demo.example.com", role: "rm", rm_name: rmName },
  { email: "test-vendor-a@alianza-demo.example.com", role: "vendor", vendor_code: vendorA },
  { email: "test-vendor-b@alianza-demo.example.com", role: "vendor", vendor_code: vendorB },
];

async function findUser(email) {
  const res = await fetch(`${secrets.url}/auth/v1/admin/users?page=1&per_page=1000`, { headers: HEADERS });
  const body = await res.json();
  return (body.users ?? body).find?.((u) => u.email === email);
}

for (const u of USERS) {
  let user = await findUser(u.email);
  if (!user) {
    const res = await fetch(`${secrets.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ email: u.email, password: secrets.test_password, email_confirm: true }),
    });
    if (!res.ok) throw new Error(`创建 ${u.email} 失败: ${res.status} ${await res.text()}`);
    user = await res.json();
    console.log(`✓ 创建 ${u.email}`);
  } else {
    console.log(`· 已存在 ${u.email}`);
  }
  const roleRow = {
    user_id: user.id,
    role: u.role,
    vendor_code: u.vendor_code ?? null,
    rm_name: u.rm_name ?? null,
  };
  const res = await fetch(`${secrets.url}/rest/v1/vg_user_roles?on_conflict=user_id`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([roleRow]),
  });
  if (!res.ok) throw new Error(`user_roles ${u.email}: ${res.status} ${await res.text()}`);
}
console.log(`\n✅ 测试账号就绪（vendor_a=${vendorA}，vendor_b=${vendorB}，rm=${rmName}）`);
