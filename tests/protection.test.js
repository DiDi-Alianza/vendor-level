// 保护期判定测试。三个官方算例直接从 rules.json 的 examples 数组驱动（数据即测试用例），
// 另覆盖跨年、15 号当天、pre_start、首单日期缺失、已计月数。
// 运行：bun test（在 05_网站/ 目录下）

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { countingStartMonth, protectionStatus } from "../src/engine/protection.js";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const rules = JSON.parse(readFileSync(join(SITE, "data", "rules.json"), "utf-8"));
const P = rules.new_vendor_protection;

describe("需求文档 2.6 三个算例（rules.json examples 驱动）", () => {
  for (const ex of P.examples) {
    test(`首单 ${ex.first_order} → 起算 ${ex.counting_start}，清退累计自 ${ex.clearance_counts_from}`, () => {
      expect(countingStartMonth(ex.first_order, P.counting_start_rule)).toBe(ex.counting_start);
      const atStart = protectionStatus(ex.first_order, ex.counting_start, P);
      expect(atStart.exemptMonths).toEqual(ex.exempt_months);
      expect(atStart.clearanceCountsFrom).toBe(ex.clearance_counts_from);
      // 豁免期内每个月都是 exempt 且不计入累计
      for (const m of ex.exempt_months) {
        const s = protectionStatus(ex.first_order, m, P);
        expect(s.status).toBe("exempt");
        expect(s.countedMonths).toBe(0);
      }
      // 清退累计起算月：counted，已计 1 个月
      const first = protectionStatus(ex.first_order, ex.clearance_counts_from, P);
      expect(first.status).toBe("counted");
      expect(first.countedMonths).toBe(1);
    });
  }
});

describe("跨年边界（12 月首单）", () => {
  test("2026-12-20（>15 号）→ 起算 2027-01，清退累计自 2027-04", () => {
    expect(countingStartMonth("2026-12-20", P.counting_start_rule)).toBe("2027-01");
    const s = protectionStatus("2026-12-20", "2027-01", P);
    expect(s.exemptMonths).toEqual(["2027-01", "2027-02", "2027-03"]);
    expect(s.clearanceCountsFrom).toBe("2027-04");
  });
  test("2026-12-15（15 号当天算 ≤15）→ 起算 2026-12，清退累计自 2027-03", () => {
    expect(countingStartMonth("2026-12-15", P.counting_start_rule)).toBe("2026-12");
    const s = protectionStatus("2026-12-15", "2026-12", P);
    expect(s.exemptMonths).toEqual(["2026-12", "2027-01", "2027-02"]);
    expect(s.clearanceCountsFrom).toBe("2027-03");
  });
  test("2026-12-31 → 起算 2027-01（月份+1 不能丢年份）", () => {
    expect(countingStartMonth("2026-12-31", P.counting_start_rule)).toBe("2027-01");
  });
});

describe("状态与计数", () => {
  test("首单 >15 号的当月评定 → pre_start（起算月还没到）", () => {
    const s = protectionStatus("2026-06-20", "2026-06", P);
    expect(s.status).toBe("pre_start");
    expect(s.monthNumber).toBe(null);
  });
  test("已计月数：首单 2026-01-10，评定 2026-07 → 第 7 个月，已计 4 个月", () => {
    const s = protectionStatus("2026-01-10", "2026-07", P);
    expect(s.status).toBe("counted");
    expect(s.monthNumber).toBe(7);
    expect(s.countedMonths).toBe(4);
  });
  test("7 月评定：起算月 2026-05 / 06 / 07 的商都在豁免期", () => {
    for (const d of ["2026-05-01", "2026-06-10", "2026-07-15"]) {
      expect(protectionStatus(d, "2026-07", P).status).toBe("exempt");
    }
    // 起算月 2026-04 的商第 4 个月，已正式计入
    expect(protectionStatus("2026-04-10", "2026-07", P).status).toBe("counted");
  });
  test("首单日期缺失 → unknown，绝不能当成非保护期", () => {
    const s = protectionStatus(null, "2026-07", P);
    expect(s.status).toBe("unknown");
    expect(s.countedMonths).toBe(null);
  });
  test("非法日期格式 → 抛错（带 code），不静默", () => {
    expect(() => countingStartMonth("2026/06/10", P.counting_start_rule)).toThrow();
    expect(() => protectionStatus("2026-06-10", "2026-7", P)).toThrow();
  });
});
