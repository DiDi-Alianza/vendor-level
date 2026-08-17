// 等级盾牌徽章（对齐 SA 证书形制：圆角盾 + 大字母 + LEVEL X + 下方刻度点）。
// 颜色档来自设计方案 V2；等级→颜色的映射是设计 token，不是业务规则。

import { t } from "../i18n.js";

const LEVEL_STYLE = {
  S: { fill: "var(--brand-deep)", ink: "#FFFFFF" },
  A: { fill: "var(--brand)", ink: "#FFFFFF" },
  B: { fill: "var(--brand-light)", ink: "var(--brand-light-ink)" },
  C: { fill: "var(--level-c)", ink: "#FFFFFF" },
};

const SHIELD_PATH =
  "M14 4 h72 q10 0 10 10 v44 q0 30 -46 52 q-46 -22 -46 -52 v-44 q0 -10 10 -10 z";

/**
 * 大徽章：完整证书形制。size = 高度 px。
 */
export function badgeLarge(level, size = 132) {
  const s = LEVEL_STYLE[level] ?? LEVEL_STYLE.C;
  const w = Math.round(size * (100 / 116));
  const ticks = [-21, -7, 7, 21]
    .map((x) => `<rect x="${50 + x - 5}" y="92" width="10" height="3" rx="1.5" fill="${s.ink}" opacity=".85"/>`)
    .join("");
  return `
  <svg class="badge-lg" width="${w}" height="${size}" viewBox="0 0 100 116" role="img"
       aria-label="${t("common.level_aria", { level })}">
    <path d="${SHIELD_PATH}" fill="${s.fill}"/>
    <path d="${SHIELD_PATH}" fill="none" stroke="${s.ink}" stroke-opacity=".55" stroke-width="2"
          transform="translate(50 58) scale(.92) translate(-50 -58)"/>
    <text x="50" y="58" text-anchor="middle" fill="${s.ink}"
          font-size="42" font-weight="600" font-family="inherit">${level}</text>
    <text x="50" y="80" text-anchor="middle" fill="${s.ink}" opacity=".85"
          font-size="9" letter-spacing="3" font-family="inherit">LEVEL ${level}</text>
    ${ticks}
  </svg>`;
}

/**
 * 行内小徽章：盾形 + 字母（≤20px 场景），旁边可跟文字。
 */
export function badgeSmall(level, size = 18) {
  const s = LEVEL_STYLE[level] ?? LEVEL_STYLE.C;
  const w = Math.round(size * (100 / 116));
  return `
  <svg width="${w}" height="${size}" viewBox="0 0 100 116" role="img"
       aria-label="${t("common.level_aria", { level })}" style="vertical-align:-3px">
    <path d="${SHIELD_PATH}" fill="${s.fill}"/>
    <text x="50" y="72" text-anchor="middle" fill="${s.ink}"
          font-size="58" font-weight="600" font-family="inherit">${level}</text>
  </svg>`;
}
