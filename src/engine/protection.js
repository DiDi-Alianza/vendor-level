// 新商保护期判定 —— 纯函数，无 I/O。规则参数全部来自 rules.json 的 new_vendor_protection / clearance。
// 月份运算一律用 year*12+month 的整数索引，避免 Date 对象的跨年/时区坑。

/** 'YYYY-MM' → 整数月索引 */
function monthIndex(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) {
    const err = new Error(`invalid month format: ${ym}`);
    err.code = "protection.invalid_month";
    err.params = { value: ym };
    throw err;
  }
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

/** 整数月索引 → 'YYYY-MM' */
function indexToMonth(idx) {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * 起算月：首单日 ≤ cutoff_day（15 号当天含）→ 首单当月；> cutoff_day → 次月。
 * 跨年由整数月索引自然处理（12 月 >15 号 → 次年 1 月）。
 * @param {string} firstOrderDate 'YYYY-MM-DD'
 * @param {object} rule rules.new_vendor_protection.counting_start_rule
 * @returns {string} 'YYYY-MM'
 */
export function countingStartMonth(firstOrderDate, rule) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(firstOrderDate);
  if (!m) {
    const err = new Error(`invalid first order date: ${firstOrderDate}`);
    err.code = "protection.invalid_date";
    err.params = { value: firstOrderDate };
    throw err;
  }
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1);
  const day = Number(m[3]);
  return indexToMonth(day <= rule.cutoff_day ? idx : idx + 1);
}

/**
 * 保护期状态。
 * @param {string|null} firstOrderDate 'YYYY-MM-DD'；null = 首单日期缺失，返回 status:'unknown'，调用方必须显式处理，不得当成非保护期
 * @param {string} ratingMonth 'YYYY-MM' 评定月
 * @param {object} protectionRules rules.new_vendor_protection
 * @returns {{
 *   status: 'exempt'|'counted'|'pre_start'|'unknown',
 *   countingStart: string|null,   // 起算月
 *   monthNumber: number|null,     // 评定月是第几个月（1-based，起算月=1）
 *   countedMonths: number|null,   // 已计入清退累计的月数（保护期内=0；第4个月=1）
 *   exemptMonths: string[],       // 保护期的三个月（保护期内正常评级，仅豁免清退累计）
 *   clearanceCountsFrom: string|null // 清退累计起算月（第 4 个月）
 * }}
 */
export function protectionStatus(firstOrderDate, ratingMonth, protectionRules) {
  const ratingIdx = monthIndex(ratingMonth);
  if (firstOrderDate == null) {
    return {
      status: "unknown",
      countingStart: null,
      monthNumber: null,
      countedMonths: null,
      exemptMonths: [],
      clearanceCountsFrom: null,
    };
  }
  const start = countingStartMonth(firstOrderDate, protectionRules.counting_start_rule);
  const startIdx = monthIndex(start);
  const exempt = protectionRules.exempt_months;
  const exemptMonths = Array.from({ length: exempt }, (_, i) => indexToMonth(startIdx + i));
  const clearanceCountsFrom = indexToMonth(startIdx + exempt);
  const monthNumber = ratingIdx - startIdx + 1; // 起算月 = 第 1 个月

  let status;
  if (monthNumber < 1) status = "pre_start"; // 评定月早于起算月（首单 >15 号的当月）
  else if (monthNumber <= exempt) status = "exempt";
  else status = "counted";

  return {
    status,
    countingStart: start,
    monthNumber: monthNumber >= 1 ? monthNumber : null,
    countedMonths: status === "counted" ? monthNumber - exempt : 0,
    exemptMonths,
    clearanceCountsFrom,
  };
}
