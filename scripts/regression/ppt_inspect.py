#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PPT 结构提取与断言，供母婴（basket）回归校验使用。

用法：
  python ppt_inspect.py dump <file.pptx>                 # 打印每页结构 JSON
  python ppt_inspect.py check <file.pptx> <expect.json>  # 按断言校验，失败时退出码为 1

expect 支持的断言（均可选）：
  {
    "slideCount": 2,
    "allShapesInsideSlide": true,         # 所有元素都在页面内
    "noOverlap": true,                    # 名字、图标、订单详情、二维码、页脚、提醒互不重叠
    "slides": [
      {
        "containsText": ["Emily", "1/2"],   # 该页所有文字中必须出现的片段（区分大小写、重音）
        "notContainsText": ["1/4"],
        "pictureCount": 2,                  # 该页图片数量（含二维码）
        "iconCount": 1,                     # 该页图标数量（不含二维码）
        "iconNames": ["A", "A", "A"],       # 该页图标，按插入顺序
        "nameText": "Emily",                # 大字名字（多行时用空格连接）
        "nameLines": 1,
        "nameFontSize": {"min": 100, "max": 275},
        "nameRuns": [{"text": "&", "font": "Calibri", "sizeDelta": -10}],  # 名字中特定文字的 run 字体 / 相对字号
        "annotation": "Sebastián",          # 特殊字符标注（红色原名）
        "noAnnotation": true,
        "groupPosition": "1/2",
        "kind": "placeholder"               # 占位页（待核对）
      }
    ]
  }
"""

import json
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

LAYOUT_SHAPES = ('name', 'name-line-', 'name-annotation', 'icon:', 'qr', 'notice', 'footer', 'process-date', 'details', 'header-', 'group-position', 'placeholder')


def extract(pptx_path):
    prs = Presentation(pptx_path)
    slide_w, slide_h = prs.slide_width, prs.slide_height
    slides = []
    for index, slide in enumerate(prs.slides, start=1):
        shapes = []
        for shape in slide.shapes:
            text = shape.text_frame.text if shape.has_text_frame else ''
            font_sizes = []
            runs = []
            if shape.has_text_frame:
                for paragraph in shape.text_frame.paragraphs:
                    for run in paragraph.runs:
                        if run.font.size is not None:
                            font_sizes.append(run.font.size.pt)
                        rgb = None
                        try:
                            rgb = str(run.font.color.rgb) if run.font.color and run.font.color.type is not None else None
                        except Exception:
                            rgb = None
                        runs.append({'text': run.text, 'font': run.font.name, 'size': run.font.size.pt if run.font.size else None, 'color': rgb})
            shapes.append({
                'name': shape.name,
                'kind': 'picture' if shape.shape_type == MSO_SHAPE_TYPE.PICTURE else 'text' if shape.has_text_frame else 'other',
                'text': text,
                'fontSizes': sorted(set(font_sizes)),
                'runs': runs,
                'box': {'left': shape.left, 'top': shape.top, 'width': shape.width, 'height': shape.height},
            })
        slides.append({'index': index, 'shapes': shapes})
    return {'slideWidth': slide_w, 'slideHeight': slide_h, 'slides': slides}


def is_layout_shape(shape):
    return any(shape['name'] == p or shape['name'].startswith(p) for p in LAYOUT_SHAPES)


def overlaps(a, b):
    ax2, ay2 = a['left'] + a['width'], a['top'] + a['height']
    bx2, by2 = b['left'] + b['width'], b['top'] + b['height']
    tol = 6350  # 0.5pt
    return not (ax2 <= b['left'] + tol or bx2 <= a['left'] + tol or ay2 <= b['top'] + tol or by2 <= a['top'] + tol)


def name_shapes(shapes):
    return [s for s in shapes if s['name'] == 'name' or s['name'].startswith('name-line-')]


def check(structure, expect):
    failures = []
    slides = structure['slides']

    if 'slideCount' in expect and len(slides) != expect['slideCount']:
        failures.append(f"页数应为 {expect['slideCount']}，实际 {len(slides)}")

    if expect.get('allShapesInsideSlide', True):
        w, h = structure['slideWidth'], structure['slideHeight']
        for slide in slides:
            for shape in slide['shapes']:
                b = shape['box']
                if b['left'] is None:
                    continue
                if b['left'] < 0 or b['top'] < 0 or b['left'] + b['width'] > w or b['top'] + b['height'] > h:
                    label = shape['name'] or shape['text'][:20] or shape['kind']
                    failures.append(f"第 {slide['index']} 页元素超出页面：{label!r}")

    if expect.get('noOverlap', True):
        for slide in slides:
            items = [s for s in slide['shapes'] if is_layout_shape(s)]
            for i in range(len(items)):
                for j in range(i + 1, len(items)):
                    if overlaps(items[i]['box'], items[j]['box']):
                        failures.append(f"第 {slide['index']} 页元素重叠：{items[i]['name']} 与 {items[j]['name']}")

    for i, slide_expect in enumerate(expect.get('slides', []), start=1):
        if slide_expect is None:
            continue
        if i > len(slides):
            failures.append(f"第 {i} 页不存在")
            continue
        shapes = slides[i - 1]['shapes']
        all_text = '\n'.join(s['text'] for s in shapes)
        by_name = {s['name']: s for s in shapes}
        for fragment in slide_expect.get('containsText', []):
            if fragment not in all_text:
                failures.append(f"第 {i} 页缺少文字 {fragment!r}")
        for fragment in slide_expect.get('notContainsText', []):
            if fragment in all_text:
                failures.append(f"第 {i} 页不应出现文字 {fragment!r}")
        if 'pictureCount' in slide_expect:
            actual = sum(1 for s in shapes if s['kind'] == 'picture')
            if actual != slide_expect['pictureCount']:
                failures.append(f"第 {i} 页图片数应为 {slide_expect['pictureCount']}，实际 {actual}")
        icons = [s['name'][5:] for s in shapes if s['name'].startswith('icon:')]
        if 'iconCount' in slide_expect and len(icons) != slide_expect['iconCount']:
            failures.append(f"第 {i} 页图标数应为 {slide_expect['iconCount']}，实际 {len(icons)}（{icons}）")
        if 'iconNames' in slide_expect and icons != slide_expect['iconNames']:
            failures.append(f"第 {i} 页图标应为 {slide_expect['iconNames']}，实际 {icons}")
        names = name_shapes(shapes)
        name_text = ' '.join(s['text'] for s in names)
        if 'nameText' in slide_expect and name_text != slide_expect['nameText']:
            failures.append(f"第 {i} 页名字应为 {slide_expect['nameText']!r}，实际 {name_text!r}")
        if 'nameLines' in slide_expect and len(names) != slide_expect['nameLines']:
            failures.append(f"第 {i} 页名字行数应为 {slide_expect['nameLines']}，实际 {len(names)}")
        if 'nameFontSize' in slide_expect and names:
            base = max(r['size'] or 0 for s in names for r in s['runs'])
            rng = slide_expect['nameFontSize']
            if base < rng.get('min', 0) or base > rng.get('max', 10000):
                failures.append(f"第 {i} 页名字字号 {base} 不在 {rng} 内")
        if 'nameColor' in slide_expect and names:
            colors = {r['color'] for s in names for r in s['runs']}
            if colors != {slide_expect['nameColor']}:
                failures.append(f"第 {i} 页名字颜色应为 {slide_expect['nameColor']}，实际 {colors}")
        for run_expect in slide_expect.get('nameRuns', []):
            runs = [r for s in names for r in s['runs']]
            base = max((r['size'] or 0) for r in runs) if runs else 0
            hit = [r for r in runs if r['text'] == run_expect['text']]
            if not hit:
                failures.append(f"第 {i} 页名字中没有单独的 run {run_expect['text']!r}（runs={[(r['text'], r['font']) for r in runs]}）")
                continue
            r = hit[0]
            if 'font' in run_expect and r['font'] != run_expect['font']:
                failures.append(f"第 {i} 页 run {run_expect['text']!r} 字体应为 {run_expect['font']}，实际 {r['font']}")
            if 'sizeDelta' in run_expect and abs((r['size'] or 0) - base - run_expect['sizeDelta']) > 0.01:
                failures.append(f"第 {i} 页 run {run_expect['text']!r} 字号应比基准 {run_expect['sizeDelta']:+}，实际 {r['size']} vs {base}")
        if 'annotation' in slide_expect:
            ann = by_name.get('name-annotation')
            if not ann or ann['text'] != slide_expect['annotation']:
                failures.append(f"第 {i} 页特殊字符标注应为 {slide_expect['annotation']!r}，实际 {ann and ann['text']!r}")
            elif ann['runs'] and (ann['runs'][0]['color'] != 'DC0000' or ann['runs'][0]['font'] not in ('Calibri',)):
                failures.append(f"第 {i} 页标注应为红色 Calibri，实际 {ann['runs'][0]}")
        if slide_expect.get('noAnnotation') and 'name-annotation' in by_name:
            failures.append(f"第 {i} 页不应有特殊字符标注")
        if 'groupPosition' in slide_expect:
            gp = by_name.get('group-position')
            if not gp or gp['text'] != slide_expect['groupPosition']:
                failures.append(f"第 {i} 页组内页码应为 {slide_expect['groupPosition']}，实际 {gp and gp['text']}")
        if slide_expect.get('kind') == 'placeholder' and 'placeholder' not in by_name:
            failures.append(f"第 {i} 页应为待核对占位页")
        if slide_expect.get('kind') == 'production' and 'placeholder' in by_name:
            failures.append(f"第 {i} 页不应是占位页")

    return failures


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ('dump', 'check'):
        print(__doc__)
        sys.exit(2)
    structure = extract(sys.argv[2])
    if sys.argv[1] == 'dump':
        print(json.dumps(structure, ensure_ascii=False, indent=2))
        return
    with open(sys.argv[3], encoding='utf-8') as f:
        expect = json.load(f)
    failures = check(structure, expect)
    for failure in failures:
        print(f"FAIL {failure}")
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
