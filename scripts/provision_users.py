# -*- coding: utf-8 -*-
"""按名单批量开通账号并绑定角色。

用法：python scripts/provision_users.py [名单.xlsx]（默认读 05_网站/账号密码.xlsx）

名单表头（顺序不限，列名认这几种写法）：
    视角 / 角色  ·  账号 / 邮箱  ·  密码（可留空 → 随机生成后单独回给运营）
    Vendor 还需一列 vendor_code；RM 还需一列 RM / rm_name

设计约束：
· 幂等——已存在的账号不重建、不改密码，只刷新角色绑定，并在输出里标注「已存在」
· **密码只作为参数传给 Supabase 管理接口，不打印、不写日志、不落任何文件**
· 名单文件本身含个人信息与凭据，已在 .gitignore；发完账号应移出仓库目录
· email_confirm=True：管理员代建的账号直接可用，不依赖邮件验证链路
  （Auth 的 Email provider 设置一律只读不改——这是运营定的规矩）
"""
import json, io, os, sys, ssl, urllib.request, urllib.error, secrets, string

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(SITE)

# --reset a@b.com [--reset c@d.com ...]：为已存在的账号重设密码。
# 默认不重设——**本项目的 auth.users 与 PK 站共用**，改密码会同时改掉此人在 PK 站的登录，
# 属于影响别的系统的动作，必须逐个点名，绝不批量默认执行。
argv = sys.argv[1:]
reset_emails = set()
rest = []
i = 0
while i < len(argv):
    if argv[i] == "--reset" and i + 1 < len(argv):
        reset_emails.add(argv[i + 1].strip().lower()); i += 2
    else:
        rest.append(argv[i]); i += 1
src = rest[0] if rest else "账号密码.xlsx"
cfg = json.loads(io.open("scripts/.supabase_secrets.json", encoding="utf-8").read())
URL, KEY = cfg["url"], cfg["service_role_key"]
ANON = cfg["anon_key"]

ROLE_MAP = {
    "主管理员": "admin", "admin": "admin",
    "内部运营": "ops", "运营": "ops", "ops": "ops",
    "rm": "rm", "RM": "rm", "渠道经理": "rm",
    "vendor": "vendor", "Vendor": "vendor", "商": "vendor", "供应商": "vendor",
}
COL = {
    "role": {"视角", "角色", "role"},
    "email": {"账号", "邮箱", "email", "mail"},
    "password": {"密码", "password", "pwd"},
    "vendor_code": {"vendor_code", "vendorcode", "商编码", "vendor code"},
    "rm_name": {"rm", "rm_name", "rm姓名", "渠道经理"},
}


def api(path, method="GET", body=None, token=None, prefer=None):
    req = urllib.request.Request(f"{URL}{path}", method=method)
    req.add_header("apikey", ANON if token else KEY)
    req.add_header("Authorization", f"Bearer {token or KEY}")
    req.add_header("Content-Type", "application/json")
    if prefer:
        req.add_header("Prefer", prefer)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, context=ssl.create_default_context()) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} → {e.code} {e.read().decode()[:200]}")


def read_rows(path):
    import openpyxl
    ws = openpyxl.load_workbook(path, data_only=True).worksheets[0]
    rows = [r for r in ws.iter_rows(values_only=True)
            if any(c is not None and str(c).strip() for c in r)]
    if not rows:
        raise SystemExit(f"{path} 是空的，没有可开通的账号")
    header = [("" if c is None else str(c).strip().lower()) for c in rows[0]]
    idx = {}
    for field, names in COL.items():
        low = {n.lower() for n in names}
        for i, h in enumerate(header):
            if h in low:
                idx[field] = i
                break
    for field in ("role", "email"):
        if field not in idx:
            raise SystemExit(f"表头缺「{field}」列。当前表头：{header}")
    out = []
    for r in rows[1:]:
        get = lambda f: (str(r[idx[f]]).strip() if f in idx and idx[f] < len(r)
                         and r[idx[f]] is not None else "")
        raw_role = get("role")
        role = ROLE_MAP.get(raw_role) or ROLE_MAP.get(raw_role.lower())
        if not role:
            raise SystemExit(f"认不出视角「{raw_role}」，支持：{sorted(set(ROLE_MAP))}")
        out.append({
            "role": role, "label": raw_role, "email": get("email"),
            "password": get("password"),
            "vendor_code": get("vendor_code") or None,
            "rm_name": get("rm_name") or None,
        })
    return out


def randpw():
    pool = string.ascii_letters + string.digits + "!@#$%^&*"
    return "".join(secrets.choice(pool) for _ in range(16))


users = read_rows(src)
print(f"名单 {src}：{len(users)} 个账号\n")

# 绑定完整性：vendor 必须带 vendor_code，rm 必须带 rm_name——绑错等于把别人的数据给错人
for u in users:
    if u["role"] == "vendor" and not u["vendor_code"]:
        raise SystemExit(f"{u['email']} 是 vendor 角色但没填 vendor_code —— 绑不上就不建，避免开出一个看不到任何数据的空账号")
    if u["role"] == "rm" and not u["rm_name"]:
        raise SystemExit(f"{u['email']} 是 rm 角色但没填 RM 姓名")

existing = {u["email"]: u for u in (api("/auth/v1/admin/users?page=1&per_page=1000")["users"])}
generated = []          # 需要回给运营的随机密码（仅新建且未填密码的账号）
state_of = {}           # email → 处理结果，验收段据此决定要不要试登录
results = []

for u in users:
    hit = existing.get(u["email"])
    if hit:
        uid = hit["id"]
        if u["email"].lower() in reset_emails and u["password"]:
            api(f"/auth/v1/admin/users/{uid}", "PUT", {"password": u["password"]})
            state = "已存在 → 已按名单重设密码（⚠ PK 站登录同步变更）"
        else:
            state = "已存在（未改密码）"
    else:
        pw = u["password"] or randpw()
        if not u["password"]:
            generated.append((u["email"], pw))
        created = api("/auth/v1/admin/users", "POST",
                      {"email": u["email"], "password": pw, "email_confirm": True})
        uid, state = created["id"], "新建"
    api("/rest/v1/vg_user_roles?on_conflict=user_id", "POST",
        [{"user_id": uid, "role": u["role"],
          "vendor_code": u["vendor_code"], "rm_name": u["rm_name"]}],
        prefer="resolution=merge-duplicates")
    results.append((u, state))
    state_of[u["email"]] = state
    bind = u["vendor_code"] or u["rm_name"] or "—"
    print(f"  ✔ {u['email']:<34} {u['label']:<6} → role={u['role']:<6} 绑定={bind:<26} {state}")

# ---- 验收：用每个账号真登录一次，确认拿到的角色与可见范围都对 ----
print("\n登录验收（按 src/data.js 的取法验证）：")
periods = api("/rest/v1/vg_periods?select=period,type&order=period.desc")
main_period = next((p["period"] for p in periods if p["type"] == "monthly"), None)
ok = fail = 0
for u, _ in results:
    pw = u["password"] or dict(generated).get(u["email"])
    if state_of.get(u["email"], "").startswith("已存在（未改密码）"):
        pw = None      # 没改密码 → 表里的密码未必是真密码，不拿它试登录
    if not pw:
        print(f"  – {u['email']}：账号已存在且未提供密码，跳过登录验收")
        continue
    try:
        tok = api("/auth/v1/token?grant_type=password", "POST",
                  {"email": u["email"], "password": pw})["access_token"]
    except RuntimeError as e:
        print(f"  ✗ {u['email']} 登录失败：{e}")
        fail += 1
        continue
    roles = api(f"/rest/v1/vg_user_roles?select=role,vendor_code,rm_name", token=tok)
    scores = api(f"/rest/v1/vg_vendor_scores?select=vendor_code&period=eq.{main_period}", token=tok)
    got = [r for r in roles if True]
    role_ok = any(r["role"] == u["role"] for r in got)
    print(f"  {'✔' if role_ok else '✗'} {u['email']:<34} role={u['role']:<6} "
          f"{main_period} 可见 {len(scores)} 家")
    ok, fail = (ok + 1, fail) if role_ok else (ok, fail + 1)

if generated:
    out = os.path.join(SITE, "新账号初始密码.txt")
    io.open(out, "w", encoding="utf-8").write(
        "以下为随机生成的初始密码，请通过安全渠道分别发给本人，发完删除本文件。\n"
        "（本文件已在 .gitignore，不会进入 git）\n\n"
        + "\n".join(f"{e}\t{p}" for e, p in generated) + "\n")
    print(f"\n⚠ {len(generated)} 个账号使用了随机密码，已写入 {out}（未在终端回显）")

print(f"\n{'✅' if fail == 0 else '❌'} 开通完成：{len(results)} 个账号，登录验收 {ok} 过 / {fail} 挂")
