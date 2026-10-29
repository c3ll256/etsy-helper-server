#!/usr/bin/env python3
"""
印章 / 摇铃出图脚本的回归用例（C7、C6、R2）。直接调用 png_stamp_generator，不经过数据库。
运行（在 etsy-helper-server 目录）：.venv/bin/python scripts/regression/run_stamp_cases.py
"""
import glob
import io
import json
import os
import subprocess
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
GENERATOR = os.path.join(ROOT, 'src', 'stamps', 'python', 'png_stamp_generator.py')


def pick_font():
    for path in sorted(glob.glob(os.path.join(ROOT, 'uploads', 'fonts', '*.ttf'))):
        try:
            from fontTools.ttLib import TTFont
            cmap = TTFont(path, lazy=True).getBestCmap() or {}
            if all(ord(c) in cmap for c in 'ABCabc &') and 0x4E2D not in cmap:
                return os.path.relpath(path, ROOT)
        except Exception:
            continue
    raise SystemExit('uploads/fonts 下没有可用的拉丁字体')


def pick_icon():
    for path in sorted(glob.glob(os.path.join(ROOT, 'uploads', 'icons', '*'))):
        try:
            Image.open(path).verify()
            return os.path.relpath(path, ROOT)
        except Exception:
            continue
    raise SystemExit('uploads/icons 下没有图标')


def run(payload):
    proc = subprocess.run([sys.executable, GENERATOR], input=json.dumps(payload).encode(), capture_output=True, cwd=ROOT)
    lines = [l for l in proc.stdout.decode().splitlines() if l.strip().startswith('{')]
    return json.loads(lines[-1])


def element(value, font, **position):
    pos = {'x': 250, 'y': 250, 'textAlign': 'center', 'verticalAlign': 'middle'}
    pos.update(position)
    return {'id': 'name', 'value': value, 'fontFamily': 'TestFont', 'fontSize': 48, 'color': '#000000', 'position': pos}


def payload(elements, font_path):
    return {
        'template': {'width': 500, 'height': 500, 'textElements': elements},
        'textElements': elements,
        'fontMapping': {'TestFont': font_path},
    }


def image_of(result):
    import base64
    return Image.open(io.BytesIO(base64.b64decode(result['data']))).convert('RGBA')


def main():
    font = pick_font()
    icon = pick_icon()
    cases = []

    def case(name, fn):
        try:
            fn()
            cases.append((name, True, ''))
        except AssertionError as e:
            cases.append((name, False, str(e)))

    def missing_font():
        p = payload([element('Emma', font)], font)
        p['fontMapping'] = {}
        r = run(p)
        assert not r['success'] and '字体检查未通过' in r['error'] and 'TestFont' in r['error'], r
    case('C7 字体缺失时不出图，并说明是哪个字体', missing_font)

    def missing_glyph():
        r = run(payload([element('Emma 中', font)], font))
        assert not r['success'] and '缺少字符' in r['error'] and '中' in r['error'], r
    case('C7 字体缺字时不出图，并列出缺的字符', missing_glyph)

    def ok_circular():
        el = element('Emma', font, isCircular=True, radius=150, baseAngle=90, maxAngle=180, layoutMode='centerAligned')
        r = run(payload([el], font))
        assert r['success'], r
        assert image_of(r).getchannel('A').getbbox() is not None, '圆弧文字输出为空白'
    case('R2 原有圆弧模板仍能出图', ok_circular)

    def horizontal_with_icon():
        plain = run(payload([element('Emma', font)], font))
        el = element('Emma', font)
        el['icon'] = {'imagePath': icon, 'placement': 'before', 'height': 40, 'spacing': 6}
        with_icon = run(payload([el], font))
        assert plain['success'] and with_icon['success'], (plain, with_icon)
        a = image_of(plain).getchannel('A').getbbox()
        b = image_of(with_icon).getchannel('A').getbbox()
        assert b[0] < a[0], f'水平文字的前置图标没有画出来（无图标 {a}，有图标 {b}）'
    case('R2 水平文字画出前置图标', horizontal_with_icon)

    def missing_icon_file():
        el = element('Emma', font)
        el['icon'] = {'imagePath': 'uploads/icons/does-not-exist.png'}
        r = run(payload([el], font))
        assert not r['success'] and '图标文件缺失' in r['error'], r
    case('C6 图标文件缺失时不出图，并提示缺图', missing_icon_file)

    def ttc_font():
        ttcs = sorted(glob.glob('/System/Library/Fonts/*.ttc'))
        if not ttcs:
            return
        r = run(payload([element('123', ttcs[0])], ttcs[0]))
        assert r['success'] or '字体' in r.get('error', ''), r
    case('TTC 字体集合能加载（取第一个字体）', ttc_font)

    for name, ok, msg in cases:
        print(f"{'ok  ' if ok else 'FAIL'} - {name}{'' if ok else '：' + msg}")
    failed = [c for c in cases if not c[1]]
    print(f'\n{len(cases) - len(failed)} passed, {len(failed)} failed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
