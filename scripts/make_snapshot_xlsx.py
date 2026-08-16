# -*- coding: utf-8 -*-
"""快照 xlsx 生成器：python make_snapshot_xlsx.py <snapshot.json> <out.xlsx>
每张表一个 sheet；json 字段（indicators/body 等）序列化为字符串单元格。由 export_snapshot.js 调用。"""
import json, sys, io
from openpyxl import Workbook

src, dest = sys.argv[1], sys.argv[2]
snap = json.loads(io.open(src, encoding="utf-8").read())

wb = Workbook()
wb.remove(wb.active)
for table, rows in snap["tables"].items():
    ws = wb.create_sheet(title=table[:31])  # sheet 名上限 31 字符
    if not rows:
        ws.append(["(空表)"])
        continue
    cols = sorted({k for r in rows for k in r.keys()})
    ws.append(cols)
    for r in rows:
        ws.append([
            json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v
            for v in (r.get(c) for c in cols)
        ])
    ws.freeze_panes = "A2"
wb.save(dest)
print(f"✓ XLSX → {dest}（{len(snap['tables'])} 个 sheet）")
