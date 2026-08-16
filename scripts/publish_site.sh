#!/usr/bin/env bash
# 发布站点到 GitHub Pages（bash scripts/publish_site.sh）
#
# 发布源是 gh-pages 分支，**只含 index.html + src/**。
# 为什么不从 main 根目录发：Pages 站点 URL 是公开的（站点访问控制仅 Enterprise Cloud 提供），
# 从 main 发会把 scripts/、supabase/*.sql、tests/ 一并挂到公网。
#
# 本脚本每次都用当前 main 的内容重建 gh-pages（单 commit，无历史），
# 因此改完站点代码只需：先把 main 推上去，再跑这个脚本。

set -euo pipefail

SITE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="https://github.com/DiDi-Alianza/vendor-level.git"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$SITE"
echo "→ 从本地仓库克隆一份工作副本"
git clone -q "$SITE" "$TMP/work"
cd "$TMP/work"

echo "→ 建立只含站点文件的孤儿分支"
git checkout -q --orphan gh-pages
git rm -rq --cached .
find . -maxdepth 1 -mindepth 1 -not -name .git -not -name index.html -not -name src -exec rm -rf {} +
git add index.html src

# 发布前自查：产物里绝不能出现内部台账或 Secret key
for forbidden in PROGRESS.md BUGS.md CLAUDE.md 需求文档.md docs scripts supabase data backups tests; do
  if [ -e "$forbidden" ]; then
    echo "✗ 发布产物里出现了不该发布的 $forbidden，已中止" >&2
    exit 1
  fi
done
if git diff --cached --name-only -z | xargs -0 grep -lI "sb_secret_\|service_role" 2>/dev/null; then
  echo "✗ 发布产物里出现了 Secret key 相关内容，已中止" >&2
  exit 1
fi

echo "→ 将发布 $(git diff --cached --name-only | wc -l) 个文件"
git -c user.email=deploy@local -c user.name=deploy commit -q -m "站点发布：仅含 index.html 与 src/"
git remote add gh "$REMOTE"
git push -qf gh gh-pages

echo "✅ 已发布 → https://didi-alianza.github.io/vendor-level/"
echo "   （GitHub Pages 通常 30–60 秒后生效）"
