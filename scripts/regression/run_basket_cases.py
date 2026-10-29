#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
母婴（basket）PPT 回归用例运行器。

每个用例是 cases/basket/<name>/ 下的一个目录：
  slides.json  传给 basket_order_generator.py 的每页数据（与 basket.service 组装的结构一致）
  expect.json  断言，格式见 ppt_inspect.py

当前用例从"每页数据"开始，校验渲染结果；解析和组页逻辑（Excel → 每页数据）
落库重构后（M3）再补 Excel 级别的用例。

用法（在 etsy-helper-server 目录下）：
  .venv/bin/python scripts/regression/run_basket_cases.py [用例名 ...]
"""

import base64
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
GENERATOR = os.path.join(SERVER_ROOT, 'src', 'basket', 'python', 'basket_order_generator.py')
CASES_DIR = os.path.join(HERE, 'cases', 'basket')

sys.path.insert(0, HERE)
from ppt_inspect import extract, check  # noqa: E402


def generate(slides):
    payload = {'orderData': base64.b64encode(json.dumps(slides).encode('utf-8')).decode('ascii')}
    proc = subprocess.run(
        [sys.executable, GENERATOR],
        input=json.dumps(payload), capture_output=True, text=True, cwd=SERVER_ROOT,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'生成器退出码 {proc.returncode}: {proc.stderr[-500:]}')
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    if not result.get('success'):
        raise RuntimeError(result.get('message'))
    if result.get('errors'):
        raise RuntimeError(f"生成器报告单页错误: {result['errors']}")
    fd, path = tempfile.mkstemp(suffix='.pptx')
    with os.fdopen(fd, 'wb') as f:
        f.write(base64.b64decode(result['data']))
    return path


def run_case(name):
    case_dir = os.path.join(CASES_DIR, name)
    with open(os.path.join(case_dir, 'slides.json'), encoding='utf-8') as f:
        slides = json.load(f)
    with open(os.path.join(case_dir, 'expect.json'), encoding='utf-8') as f:
        expect = json.load(f)
    pptx_path = generate(slides)
    try:
        return check(extract(pptx_path), expect)
    finally:
        os.unlink(pptx_path)


def main():
    names = sys.argv[1:] or sorted(
        d for d in os.listdir(CASES_DIR) if os.path.isdir(os.path.join(CASES_DIR, d))
    )
    failed = 0
    for name in names:
        try:
            failures = run_case(name)
        except Exception as e:  # 生成失败也算用例失败
            failures = [f'运行出错: {e}']
        status = 'PASS' if not failures else 'FAIL'
        print(f'{status} {name}')
        for failure in failures:
            print(f'    {failure}')
        failed += bool(failures)
    print(f'\n{len(names) - failed}/{len(names)} 通过')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
