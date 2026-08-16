// 三语覆盖率与缺译清单：bun scripts/i18n_status.js [--list es] [--stale]
// 用途：规则文案在中文母本定稿后逐块翻译，用本脚本盯住"翻到哪了、还差什么"，避免漏译。
//   --list <lang>  列出该语言缺的键（默认只报数量）
//   --stale        列出「已翻但中文母本之后改过」的可疑键（靠 zh 有值、目标语言有值但内容明显是旧版长度差异过大来粗判，仅提示）

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const I18N = join(SITE, "src", "i18n");
const LANGS = ["zh", "es", "en"];
const args = process.argv.slice(2);
const listLang = args.includes("--list") ? args[args.indexOf("--list") + 1] : null;

const load = (l) => {
  const p = join(I18N, `${l}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {};
};
const packs = Object.fromEntries(LANGS.map((l) => [l, load(l)]));
const zhKeys = Object.keys(packs.zh);

// 按前缀归类，便于判断"哪一块翻完了"
const groupOf = (k) => k.split(".")[0];
const groups = [...new Set(zhKeys.map(groupOf))].sort();

console.log(`中文母本共 ${zhKeys.length} 个键\n`);
console.log("语言    已翻     覆盖率");
console.log("-".repeat(30));
for (const l of LANGS) {
  const have = zhKeys.filter((k) => packs[l][k] !== undefined).length;
  console.log(`${l.padEnd(7)} ${String(have).padStart(4)}/${zhKeys.length}   ${((have / zhKeys.length) * 100).toFixed(1)}%`);
}

console.log(`\n分块覆盖率（前缀）：`);
console.log(`${"块".padEnd(22)} ${"键数".padStart(4)}   es      en`);
console.log("-".repeat(48));
for (const g of groups) {
  const keys = zhKeys.filter((k) => groupOf(k) === g);
  const pctOf = (l) => `${((keys.filter((k) => packs[l][k] !== undefined).length / keys.length) * 100).toFixed(0)}%`;
  console.log(`${g.padEnd(22)} ${String(keys.length).padStart(4)}   ${pctOf("es").padStart(4)}   ${pctOf("en").padStart(4)}`);
}

// 目标语言里有、但中文母本已删的键 → 陈旧残留
for (const l of ["es", "en"]) {
  const orphan = Object.keys(packs[l]).filter((k) => packs.zh[k] === undefined);
  if (orphan.length) console.log(`\n⚠️ ${l}.json 有 ${orphan.length} 个键在中文母本里已不存在（应删）：${orphan.slice(0, 10).join(", ")}${orphan.length > 10 ? " …" : ""}`);
}

if (listLang) {
  const miss = zhKeys.filter((k) => packs[listLang]?.[k] === undefined);
  console.log(`\n${listLang} 缺译 ${miss.length} 个键：`);
  for (const k of miss) console.log(`  ${k}`);
}
console.log(`\n提示：只翻已定稿的块。规则文案（rules.* / indicator.* / changelog.*）的西英术语必须取自 04_透传材料 的官宣版，不另起译法。`);
