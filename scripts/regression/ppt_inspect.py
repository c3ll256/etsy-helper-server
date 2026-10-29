#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PPT 结构提取与断言，供母婴（basket）回归校验使用。

用法：
  python ppt_inspect.py dump <file.pptx>                 # 打印每页结构 JSON
  python ppt_inspect.py check <file.pptx> <expect.json>  # 按断言校验，失败时退出码为 1

expect.json 支持的断言（均可选）：
  {
    "slideCount": 2,
    "allShapesInsideSlide": true,
    "slides": [
      {
        "containsText": ["Emily", "1/2"],   # 该页所有文字中必须出现的片段（区分大小写、重音）
        "notContainsText": ["1/4"],
        "pictureCount": 2                   # 该页图片数量（含二维码）
      }
    ]
  }
"""

import json
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE


def extract(pptx_path):
    prs = Presentation(pptx_path)
    slide_w, slide_h = prs.slide_width, prs.slide_height
    slides = []
    for index, slide in enumerate(prs.slides, start=1):
        shapes = []
        for shape in slide.shapes:
            text = shape.text_frame.text if shape.has_text_frame else ''
            font_sizes = []
            if shape.has_text_frame:
                for paragraph in shape.text_frame.paragraphs:
                    for run in paragraph.runs:
                        if run.font.size is not None:
                            font_sizes.append(run.font.size.pt)
                    if paragraph.font.size is not None:
                        font_sizes.append(paragraph.font.size.pt)
            shapes.append({
                'kind': 'picture' if shape.shape_type == MSO_SHAPE_TYPE.PICTURE else 'text' if shape.has_text_frame else 'other',
                'text': text,
                'fontSizes': sorted(set(font_sizes)),
                'box': {
                    'left': shape.left, 'top': shape.top, 'width': shape.width, 'height': shape.height,
                },
            })
        slides.append({'index': index, 'shapes': shapes})
    return {'slideWidth': slide_w, 'slideHeight': slide_h, 'slides': slides}


def check(structure, expect):
    failures = []
    slides = structure['slides']

    if 'slideCount' in expect and len(slides) != expect['slideCount']:
        failures.append(f"页数应为 {expect['slideCount']}，实际 {len(slides)}")

    if expect.get('allShapesInsideSlide'):
        w, h = structure['slideWidth'], structure['slideHeight']
        for slide in slides:
            for shape in slide['shapes']:
                b = shape['box']
                if b['left'] is None:
                    continue
                if b['left'] < 0 or b['top'] < 0 or b['left'] + b['width'] > w or b['top'] + b['height'] > h:
                    label = shape['text'][:20] or shape['kind']
                    failures.append(f"第 {slide['index']} 页元素超出页面：{label!r}")

    for i, slide_expect in enumerate(expect.get('slides', []), start=1):
        if i > len(slides):
            failures.append(f"第 {i} 页不存在")
            continue
        shapes = slides[i - 1]['shapes']
        all_text = '\n'.join(s['text'] for s in shapes)
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
