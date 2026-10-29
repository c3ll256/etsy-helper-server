#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
母婴（basket）回归用例运行器：从 Excel 输入跑完整流水线（解析 → 匹配 → 制作单元 → 布局计划 → PPT），
再对明细结果和 PPT 结构做断言。

每个用例是 cases/basket/<name>/case.json：
  {
    "title": "说明", "acceptance": "02",
    "rows": [{"Order ID": "...", "SKU": "...", "Quantity": 2, "Variations": "...", "Note": "..."}],   # 合成数据
    "fixturePatch": {"settings": {...}, "configs": [...]},     # 可选：覆盖 _fixture.json（configs 按 id 替换 / 追加）
    "ppt": { ... },                                            # ppt_inspect.py 的断言；为 null 表示不应生成 PPT
    "lines": [{"row": 2, "status": "produced", "units": 2, "names": ["Emily"], "icons": [["A","A"]], ...}],
    "stats": {"unitsProduced": 2}
  }
lines 断言字段：status, category, reasonContains, warningContains, units, names, icons, slots, groupPositions,
  reminder（子串）, reminderNull, orderHasPages, duplicateOf, attachments, fields（label→value）, quantity, matchStatus, matchedSku, parseSource

用法（在 etsy-helper-server 目录下）：
  .venv/bin/python scripts/regression/run_basket_cases.py [用例名 ...]
"""

import copy
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
CASES_DIR = os.path.join(HERE, 'cases', 'basket')
CLI = os.path.join(HERE, 'basket_pipeline_cli.ts')

sys.path.insert(0, HERE)
from ppt_inspect import extract, check  # noqa: E402

HEADERS = ['Sale Date', 'Date Paid', 'Item Name', 'Quantity', 'Ship Name', 'Order ID', 'Transaction ID', 'Variations', 'SKU', 'Note']


def write_xlsx(rows, path):
    import xlsxwriter
    keys = list(HEADERS)
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    wb = xlsxwriter.Workbook(path)
    ws = wb.add_worksheet()
    for c, k in enumerate(keys):
        ws.write_string(0, c, k)
    for r, row in enumerate(rows, start=1):
        for c, k in enumerate(keys):
            v = row.get(k, '')
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                ws.write_number(r, c, v)
            else:
                ws.write_string(r, c, str(v))
    wb.close()


def merged_fixture(patch):
    with open(os.path.join(CASES_DIR, '_fixture.json'), encoding='utf-8') as f:
        fixture = json.load(f)
    patch = patch or {}
    for key, value in patch.items():
        if key == 'configs':
            by_id = {c['id']: c for c in fixture['configs']}
            for c in value:
                by_id[c['id']] = {**by_id.get(c['id'], {}), **c}
            fixture['configs'] = list(by_id.values())
        elif key == 'settings':
            fixture['settings'] = {**fixture.get('settings', {}), **value}
        elif key == 'iconGroups':
            fixture['iconGroups'].update(value)
        elif key == 'layoutTemplates':
            by_id = {t['id']: t for t in fixture['layoutTemplates']}
            for t in value:
                by_id[t['id']] = t
            fixture['layoutTemplates'] = list(by_id.values())
        else:
            fixture[key] = value
    return fixture


def run_pipeline(case, workdir):
    xlsx = os.path.join(workdir, 'input.xlsx')
    write_xlsx(case['rows'], xlsx)
    fixture_path = os.path.join(workdir, 'fixture.json')
    with open(fixture_path, 'w', encoding='utf-8') as f:
        json.dump(merged_fixture(case.get('fixturePatch')), f, ensure_ascii=False)
    out = os.path.join(workdir, 'out.pptx')
    report = os.path.join(workdir, 'report.json')
    proc = subprocess.run(
        ['npx', 'ts-node', '--transpile-only', '-P', 'tsconfig.json', CLI, '--excel', xlsx, '--fixture', fixture_path, '--out', out, '--report', report],
        cwd=SERVER_ROOT, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'流水线退出码 {proc.returncode}: {proc.stderr[-1500:]}')
    with open(report, encoding='utf-8') as f:
        return json.load(f), (out if os.path.exists(out) else None)


def check_lines(report, expects):
    failures = []
    by_row = {l['rowIndex']: l for l in report['lines']}
    for e in expects:
        row = e['row']
        line = by_row.get(row)
        if not line:
            failures.append(f'行 {row} 不存在')
            continue
        tag = f'行 {row}'
        def eq(field, actual, expected):
            if actual != expected:
                failures.append(f'{tag} {field} 应为 {expected!r}，实际 {actual!r}')
        if 'status' in e:
            eq('status', line['status'], e['status'])
        if 'category' in e:
            eq('exceptionCategory', line['exceptionCategory'], e['category'])
        if 'matchStatus' in e:
            eq('matchStatus', line['matchStatus'], e['matchStatus'])
        if 'matchedSku' in e:
            eq('matchedSku', line['matchedSku'], e['matchedSku'])
        if 'quantity' in e:
            eq('quantity', line['quantity'], e['quantity'])
        if 'parseSource' in e:
            eq('parseSource', (line.get('parse') or {}).get('source'), e['parseSource'])
        for frag in e.get('reasonContains', []):
            if not any(frag in r for r in line['reasons']):
                failures.append(f'{tag} 原因中缺少 {frag!r}（实际 {line["reasons"]}）')
        for frag in e.get('warningContains', []):
            if not any(frag in r for r in line['warnings']):
                failures.append(f'{tag} 提示中缺少 {frag!r}（实际 {line["warnings"]}）')
        if e.get('noReasons') and line['reasons']:
            failures.append(f'{tag} 不应有阻断原因，实际 {line["reasons"]}')
        units = line['units']
        if 'units' in e:
            eq('制作单元数', len(units), e['units'])
        if 'names' in e:
            eq('名字', [u['name'] for u in units], e['names'])
        if 'components' in e:
            eq('组成件', [u['component'] for u in units], e['components'])
        if 'icons' in e:
            eq('图标', [[i['name'] for i in u['icons']] for u in units], e['icons'])
        if 'slots' in e:
            eq('图标位置', [[i['slot'] for i in u['icons']] for u in units], e['slots'])
        if 'colors' in e:
            eq('颜色', [[u['colorRaw'], u['colorMapped']] for u in units], e['colors'])
        if 'groupPositions' in e:
            eq('组内页码', [u['groupPosition'] for u in units], e['groupPositions'])
        if 'reminder' in e:
            if not line['reminderText'] or e['reminder'] not in line['reminderText']:
                failures.append(f'{tag} 连单提醒应包含 {e["reminder"]!r}，实际 {line["reminderText"]!r}')
        if e.get('reminderNull') and line['reminderText']:
            failures.append(f'{tag} 不应有连单提醒，实际 {line["reminderText"]!r}')
        if 'orderHasPages' in e:
            eq('orderHasPages', line['orderHasPages'], e['orderHasPages'])
        if 'duplicateOf' in e:
            eq('duplicateOf', line['duplicateOf'], e['duplicateOf'])
        if 'note' in e:
            eq('NOTE 原文', line['noteRaw'], e['note'])
        if 'attachments' in e:
            eq('附件', (line.get('parse') or {}).get('attachments'), e['attachments'])
        for label, value in (e.get('fields') or {}).items():
            fields = (line.get('parse') or {}).get('fields') or []
            hit = [f for f in fields if f['label'] == label]
            if not hit:
                failures.append(f'{tag} 没有字段 {label!r}（实际 {[f["label"] for f in fields]}）')
            elif hit[0]['value'] != value:
                failures.append(f'{tag} 字段 {label!r} 应为 {value!r}，实际 {hit[0]["value"]!r}')
    return failures


def run_case(name):
    with open(os.path.join(CASES_DIR, name, 'case.json'), encoding='utf-8') as f:
        case = json.load(f)
    with tempfile.TemporaryDirectory() as workdir:
        report, pptx = run_pipeline(case, workdir)
        failures = check_lines(report, case.get('lines', []))
        for k, v in (case.get('stats') or {}).items():
            if report['stats'].get(k) != v:
                failures.append(f'stats.{k} 应为 {v}，实际 {report["stats"].get(k)}')
        if 'ppt' in case:
            if case['ppt'] is None:
                if pptx:
                    failures.append('不应生成 PPT')
            elif not pptx:
                failures.append('没有生成 PPT')
            else:
                failures.extend(check(extract(pptx), case['ppt']))
        if os.environ.get('KEEP_PPT') and pptx:
            dst = os.path.join(os.environ['KEEP_PPT'], f'{name}.pptx')
            os.makedirs(os.environ['KEEP_PPT'], exist_ok=True)
            with open(pptx, 'rb') as a, open(dst, 'wb') as b:
                b.write(a.read())
        return failures, case.get('title', '')


def main():
    names = sys.argv[1:] or sorted(d for d in os.listdir(CASES_DIR) if os.path.isdir(os.path.join(CASES_DIR, d)))
    failed = 0
    for name in names:
        try:
            failures, title = run_case(name)
        except Exception as e:
            failures, title = [f'运行出错: {e}'], ''
        status = 'PASS' if not failures else 'FAIL'
        print(f'{status} {name}  {title}')
        for failure in failures:
            print(f'    {failure}')
        failed += bool(failures)
    print(f'\n{len(names) - failed}/{len(names)} 通过')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
