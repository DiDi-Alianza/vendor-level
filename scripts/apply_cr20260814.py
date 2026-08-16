# -*- coding: utf-8 -*-
"""CR-20260814 执行脚本（A1–A8 + B1–B4）。A9/A10 已先行执行，本脚本不再动信用档位。
一次性迁移脚本，执行后保留作为审计记录。跑完必须过四件套 + rule_change_impact。"""
import json, io, shutil, datetime, os

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
P = 'data/rules.json'
stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
shutil.copy(P, f'data/rules_history/rules_{stamp}_beforeCR20260814.json')
r = json.loads(io.open(P, encoding='utf-8').read())
log = []

# ---------------- A1：删除 S 规模门槛（字段保留，置 enabled:false 便于日后恢复） ----------------
assert r['s_scale_gate']['enabled'] is True
r['s_scale_gate']['enabled'] = False
r['s_scale_gate']['_note'] = ("CR-20260814 A1：**已停用**。原为「总分达 S 线且日均完美单量 ≥1250 才授 S」，"
                              "对中上规模商过于严苛、再努力也过不了，失去激励意义。字段结构保留以便日后恢复；"
                              "enabled=false 时引擎不做门槛校验，页面相关解释一并下线。")
log.append('A1 s_scale_gate.enabled: true → false')

# ---------------- A2–A4：S 线拆分城 ----------------
assert r['level_lines']['shared'].get('S') == 80
del r['level_lines']['shared']['S']
r['level_lines']['by_city']['CDMX']['S'] = 80
r['level_lines']['by_city']['MTY']['S'] = 85
log.append('A2 level_lines.shared.S: 80 → 删除（S 不再全市场统一）')
log.append('A3 level_lines.by_city.CDMX.S: 新增 = 80')
log.append('A4 level_lines.by_city.MTY.S: 新增 = 85')

# ---------------- A5–A7：A / C 线 ----------------
for city, key, old, new, tag in [
    ('CDMX', 'A', 65, 45, 'A5'), ('MTY', 'A', 75, 65, 'A6'),
    ('CDMX', 'C', 30, 15, 'A7a'), ('MTY', 'C', 35, 15, 'A7b'),
]:
    assert r['level_lines']['by_city'][city][key] == old, (city, key, r['level_lines']['by_city'][city][key])
    r['level_lines']['by_city'][city][key] = new
    log.append(f'{tag} level_lines.by_city.{city}.{key}: {old} → {new}')

r['level_lines']['_note'] = ("CR-20260814：S / A / C 三条线**均按城市**设定（原 S 线全市场统一已废止）。"
                             "机制澄清：S+A 总量只由 A 线决定，S 线只在 SA 内部切分 S 与 A。取值一律取整 5 或 10。")

# ---------------- A8：拉新档位（分母改新招骑手后量级完全不同） ----------------
nr = [i for i in r['indicators'] if i['key'] == 'newrider'][0]
assert [t['gte'] for t in nr['tiers']] == [20, 12, 6, 0]
nr['tiers'] = [
    {"gte": 70, "score": 100},
    {"gte": 50, "score": 80},
    {"gte": 30, "score": 50},
    {"gte": 0,  "score": 0},
]
log.append('A8 newrider.tiers 门槛: ≥20/12/6 → ≥70/50/30（分值 100/80/50/0 不变）')

# ---------------- B3：拉新口径（分母 完单骑手 → 当月新招骑手） ----------------
nr['_note'] = ("CR-20260814 B3：口径 = 行业全新骑手（CURP 认定）÷ **当月新招骑手**，衡量拉新**质量**"
               "（新招的人里有多少是行业全新），原分母为完单骑手、衡量的是数量强度。"
               "档位随分母量级重设为 ≥70/50/30（平台合计 57%，4–7 月四个月落档最均衡，中位 50% 作 80 分线）。")
log.append('B3 newrider._note: 分母改「当月新招骑手」，口径说明更新')

# ---------------- B1：信用分只看逾期占比（方案 i：保留 composite 结构） ----------------
cred = [i for i in r['indicators'] if i['key'] == 'credit'][0]
comps = cred['composite']['components']
assert any(c['key'] == 'bad_debt_ratio' for c in comps)
cred['composite']['components'] = [c for c in comps if c['key'] == 'overdue_ratio']
cred['composite']['components'][0]['weight'] = 1.0
cred['_note'] = ("CR-20260814 B1：**坏账占比不再参与计算**，还款信用 = 逾期>7 天占比得分（当月各周快照均值）。"
                 "满分判定见 A10：逾期占比 = 0 即满分，不要求完全没有欠款。"
                 "结构上保留 composite（components 只留 overdue_ratio、weight 1.0），日后要恢复坏账项只改数据不改代码。")
log.append('B1 credit.composite.components: 删除 bad_debt_ratio；overdue_ratio.weight 0.6 → 1.0')

# ---------------- B2：Slot 改按日累计 ----------------
slot = [i for i in r['indicators'] if i['key'] == 'slot'][0]
slot['_note'] = ("CR-20260814 B2：口径 = **该月每天达成的 slot 数 ÷ 该月总 Target 数**（按日聚合，非各周均值）。"
                 "单个 slot 判定「达成」的阈值 = 出勤骑手数 ≥ 目标的 70%（用周表 Achieved slot# 反推，113/113 家吻合；"
                 "官宣材料对外保留占位符不填具体数）。档位 ≥90/70/40 不变。")
log.append('B2 slot._note: 改按日累计（Σ达成÷Σ目标，单 slot 阈值 70%）')

# ---------------- B4：评定窗口对齐自然月 ----------------
orders = [i for i in r['indicators'] if i['key'] == 'orders'][0]
orders['_note'] = ("CR-20260814 B4：日均完美单量 = 当期完美单总量 ÷ 当期天数（月度按自然日数，周度 ÷7）。"
                   "**评定窗口对齐自然月**（如 7 月 = 7/1–7/31，31 天）——原为账单 5 周窗口（6/29–8/2，35 天）。"
                   "⚠️ 7 月数据的完美单为 10 分钟口径（数据源限制），8 月起切官方 DETA+1min。")
r['evaluation_window'] = {
    "type": "natural_month",
    "_note": "CR-20260814 B4：评定窗口 = 自然月（月初到月末）。周度试算窗口 = 自然周 7 天。"
             "所有指标（完美单/Slot/D-3R/信用/拉新/合规）统一按此窗口取数，不再使用账单 5 周窗口。",
}
log.append('B4 orders._note + 新增 evaluation_window: 对齐自然月')

# ---------------- changelog ----------------
r['changelog'].append({
    "version": "V6",
    "effective_from": "2026-09",
    "date": "2026-08-14",
    "summary_key": "changelog.cr0814.summary",
    "changes_keys": [
        "changelog.cr0814.drop_s_gate",
        "changelog.cr0814.s_by_city",
        "changelog.cr0814.lines_recalibrated",
        "changelog.cr0814.credit_overdue_only",
        "changelog.cr0814.slot_daily",
        "changelog.cr0814.newrider_denominator",
        "changelog.cr0814.natural_month",
    ],
    "reason_key": "changelog.cr0814.reason",
    "_cr": "CR-20260814 A1–A8 + B1–B4",
})

io.open(P, 'w', encoding='utf-8').write(json.dumps(r, ensure_ascii=False, indent=1))
print(f'备份: data/rules_history/rules_{stamp}_beforeCR20260814.json')
print(f'\n已执行 {len(log)} 项：')
for x in log:
    print('  ·', x)
print('\n新分数线:', json.dumps(r['level_lines']['by_city'], ensure_ascii=False))
print('shared:', json.dumps(r['level_lines']['shared'], ensure_ascii=False))
