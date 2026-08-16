// 演示静态服务器：bun scripts/serve.js [port]（默认 8017），根目录 = 05_网站/
// 附本地规则写入 API（仅供演示阶段规则编辑器使用，无鉴权——不是上线方案，见铁律 12）：
//   POST /api/rules          {rules, reason} → 备份旧版到 data/rules_history/ 后写入 data/rules.json
//   GET  /api/rules_history  → 备份文件列表（新→旧）
//   POST /api/rules_restore  {file} → 回滚到某备份（当前版本先自动备份）
import { join, dirname, extname, normalize, basename } from "path";
import { fileURLToPath } from "url";
import { readdirSync, mkdirSync, existsSync } from "fs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2] ?? 8017);
const RULES_PATH = join(ROOT, "data", "rules.json");
const HISTORY_DIR = join(ROOT, "data", "rules_history");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".pdf": "application/pdf",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

function backupStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function backupCurrent() {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  const name = `rules_${backupStamp()}.json`;
  await Bun.write(join(HISTORY_DIR, name), await Bun.file(RULES_PATH).text());
  return name;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    if (path === "/api/rules" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body?.rules?.indicators || !body?.reason?.trim()) {
        return json({ ok: false, error: "invalid_payload" }, 400);
      }
      const backup = await backupCurrent();
      await Bun.write(RULES_PATH, JSON.stringify(body.rules, null, 1));
      return json({ ok: true, backup });
    }

    if (path === "/api/rules_history" && req.method === "GET") {
      const files = existsSync(HISTORY_DIR)
        ? readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")).sort().reverse()
        : [];
      return json({ ok: true, files });
    }

    if (path === "/api/rules_restore" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const file = body?.file && basename(body.file); // 防路径穿越
      const full = join(HISTORY_DIR, file ?? "");
      if (!file || !existsSync(full)) return json({ ok: false, error: "backup_not_found" }, 404);
      const backup = await backupCurrent();
      await Bun.write(RULES_PATH, await Bun.file(full).text());
      return json({ ok: true, restored: file, backup });
    }

    let filePath = path === "/" ? "/index.html" : path;
    const full = normalize(join(ROOT, filePath));
    if (!full.startsWith(ROOT)) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(full);
    if (!(await file.exists())) return new Response("Not Found", { status: 404 });
    return new Response(file, {
      headers: { "Content-Type": TYPES[extname(full)] ?? "application/octet-stream" },
    });
  },
});

console.log(`serving ${ROOT} at http://localhost:${PORT}`);
