// 评定周期工具。全月外推口径 = 日均 × 当月自然日天数（已用最大单量商的实发金额做过锚点校验）。
export function daysInMonth(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) {
    const err = new Error(`invalid month: ${ym}`);
    err.code = "period.invalid_month";
    throw err;
  }
  return new Date(Number(m[1]), Number(m[2]), 0).getDate();
}
