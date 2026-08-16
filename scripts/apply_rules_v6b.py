# -*- coding: utf-8 -*-
"""2026-08-13 口径定稿落盘（分析会话拍板，一次性迁移脚本）：
①flex_adjustment 加/扣分分开 ②指标口径与改键 ③credit 解锁 ④period 挪数据文件 ⑤redline 关系注 ⑥changelog v6b
同时改 vendors_2026_07.json：指标键重命名 + period 落位。跑完必须过 validate_rules + recalc + bun test。"""
import json, io

RULES = "data/rules.json"
VENDORS = "data/vendors_2026_07.json"

r = json.loads(io.open(RULES, encoding="utf-8").read())
v = json.loads(io.open(VENDORS, encoding="utf-8").read())

# ---------- ① flex_adjustment：加分/扣分分开定义 ----------
r["flex_adjustment"] = {
    "max_abs": 10,
    "note_key": "rules.flex.note",
    "_note": "灵活分上限 ±10，加分与扣分性质不同，分开定义、分开展示（不得只给净值）。演示数据不含灵活分，结构就位。",
    "application_order": [
        "weighted_total", "flex_adjustment_net", "level_lines", "s_scale_gate", "redline_level_cap"
    ],
    "_order_note": "计算顺序：六项加权=综合分 → 加灵活分净值 → 判等级 → S 规模门槛校验（日均完美单量 ≥1250 是硬条件，加分不能突破）→ 红线封顶 B（最终硬约束）。",
    "components": {
        "activity_bonus": {
            "sign": "positive",
            "note_key": "flex.activity.note",
            "_note": "运营活动加分：提前公示任务清单+每项分值（如新区试点、周度冲刺），商家主动去挣。对商完全可见。"
        },
        "penalty": {
            "sign": "negative",
            "note_key": "flex.penalty.note",
            "_note": "违规扣分：事后认定，必须带可对外说明的原因，事后告知商家（扣多少分、为什么扣）。",
            "no_double_penalty": {
                "_note": "【边界，不可违反】扣分只适用于现有六项指标覆盖不到的违规行为。下列行为已有机制计扣，禁止再用 penalty 重复计扣（欠款严重已被扣两次：信用分 20% 权重 + 红线封顶 B 并没收现金激励，绝不能扣第三次）：",
                "prohibited": [
                    {"behavior": "欠款逾期（>7 天）", "covered_by": "credit 指标 · 逾期占比分项（60%）"},
                    {"behavior": "坏账（逾期 >30 天）", "covered_by": "credit 指标 · 坏账占比分项（40%）"},
                    {"behavior": "欠款红线触发", "covered_by": "redline：等级封顶 B + 当月现金激励没收"}
                ]
            }
        }
    },
    "per_vendor_schema": {
        "_note": "按商记录在数据文件 vendors[].flex_adjustments 数组：{value: 数值(加分为正/扣分为负), type: activity_bonus|penalty, reason_key: 对外可说明的原因（i18n 键或字面文本）}。模拟器把灵活分作为已知输入参与计算，不得事后推翻。",
        "fields": ["value", "type", "reason_key"]
    }
}

# ---------- ② 四个指标口径 ----------
for ind in r["indicators"]:
    if ind["key"] == "orders":
        ind["unit"] = "完美单/日"
        ind["_note"] = ("口径=完美单量（官方 DETA+1min）。日均完美单量 = 当期完美单总量 ÷ 当期天数"
                        "（月度÷自然日数，周度÷7）。7 月演示数据为完单口径代理（完美率 99%+，档位结果一致）。")
    elif ind["key"] == "r2":
        ind["key"] = "d3r"
        ind["name_key"] = "indicator.d3r"
        ind["_note"] = ("对商公示名 D-3R%。同一指标的三个历史名字：账单列 3R、7 月结果表 D-duty 2R%、官宣 D-3R%。"
                        "档位 <1 / 1–2 / 2–3 / ≥3 不变。")
    elif ind["key"] == "identity":
        ind["key"] = "blocked_rider_rate"
        ind["name_key"] = "indicator.blocked_rider_rate"
        ind["_note"] = ("展示名「合规账号率」，键名 blocked_rider_rate 字面即方向（lower_better，封禁率越低越好）。"
                        "口径：当月被封禁骑手 ÷ 当月完单骑手。分子筛选条件：channel_source=Anti-Fraud 且 "
                        "block_strategy_name=反作弊-红线封禁，rider_id 去重。")
    elif ind["key"] == "newrider":
        ind.pop("proxy_notice_key", None)
        ind.pop("_proxy", None)
        ind["_note"] = ("口径：CURP 认定的「行业全新」骑手 ÷ 完单骑手，档位 ≥20/12/6% 不变。真实 CURP 数据已接入"
                        "（2026-08-12），旧的 2–7 月累计月均代理口径作废。三层关系：平台新骑手 ⊃ Vendor 新进"
                        "（CURP 去重 7,901）⊃ 行业全新（5,378）。")

# ---------- ③ credit 解锁 ----------
for ind in r["indicators"]:
    if ind["key"] == "credit":
        ind.pop("input_type", None)
        ind["input_type"] = "composite"
        ind["_note"] = ("复合分已解锁（2026-08-13）：周度测算可从《逾期明细_0811》算出两个分项"
                        "（逾期>7天占比、坏账>30天占比），沙盘信用档位限制解除。数据文件提供 "
                        "components: {overdue_ratio, bad_debt_ratio} 或 no_debt 标记时按复合档位重算；"
                        "提供单一数值时视为已算好的最终分（7 月演示数据为此形态，兼容）。")

# ---------- ④ period 挪到数据文件 ----------
period = r.pop("period", None)
if period:
    v["meta"]["period_detail"] = {
        "label": period["label"],
        "weeks": period["weeks"],
        "_note": "评定期属于数据文件，不属于规则（2026-08-13 从 rules.json 迁入）。",
    }

# ---------- ⑤ redline 两条机制的关系 ----------
r["redline"]["_relation_note"] = ("level_cap 与 forfeit_cash_incentive 二者不叠加扣减：封顶 B 本身使现金激励自动为零"
                                  "（B 级单价 0），forfeit_cash_incentive 是显式声明。保留后者是因为对商说"
                                  "「当月激励没收」比「降到 B」威慑力强。")

# ---------- ② s_scale_gate 注释修正 ----------
r["s_scale_gate"]["_note"] = ("总分达 S 线但日均完美单量未达 ≥1250 → 只授 A。两城一致。硬条件：灵活分加分不能突破本门槛。"
                              "必须在页面上明确解释，否则引发申诉。")

# ---------- ⑥ changelog v6b ----------
r["changelog"].append({
    "version": "V6",
    "effective_from": "2026-08",
    "date": "2026-08-13",
    "summary_key": "changelog.v6b.summary",
    "changes_keys": [
        "changelog.v6b.flex_split",
        "changelog.v6b.orders_caliber",
        "changelog.v6b.d3r_naming",
        "changelog.v6b.blocked_rider",
        "changelog.v6b.newrider_real",
        "changelog.v6b.credit_unlock",
    ],
    "reason_key": "changelog.v6b.reason",
})

# ---------- vendors 数据文件：指标键重命名 ----------
renames = {"r2": "d3r", "identity": "blocked_rider_rate"}
cnt = 0
for vendor in v["vendors"]:
    for ind in vendor["indicators"]:
        if ind["key"] in renames:
            ind["key"] = renames[ind["key"]]
            cnt += 1

io.open(RULES, "w", encoding="utf-8").write(json.dumps(r, ensure_ascii=False, indent=1))
io.open(VENDORS, "w", encoding="utf-8").write(json.dumps(v, ensure_ascii=False, indent=1))
print(f"rules.json 六处更新完成；vendors 指标键重命名 {cnt} 处；period 迁入 meta.period_detail")
