#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
母婴（basket）制作页生成器 v2：布局计划 + 渲染。

输入（stdin JSON）：{"orderData": base64(JSON 请求), "outputPath": 可选}
JSON 请求：
  {
    "mode": "plan" | "render",
    "fonts": [{"name": "...", "path": "uploads/fonts/xxx.ttf"}],   # 字体表（来自 fonts 表）
    "slides": [ ... ]                                                # 每页规格，见 basket.service / slide-planner.ts
  }

plan  ：只测量，不生成 PPT。按真实字体文件（PIL）测量名字，在 SKU 配置的安全区内从最大字号往下缩，
        检查与图标、订单详情、二维码、页脚是否重叠，返回每页的排版结果和问题。
render：按同样的算法生成 PPT，并返回每页实际插入的图标数等结构信息（供"实际插入"校验和回归测试）。

页面分区（相对幻灯片的百分比）：
  顶部 0–8      ：左 订单日期 / 中 标题（订单号-商品-颜色-图标）/ 右 组内页码
  详情 8.5–19.5 ：订单详情（SKU、件次、原始定制、制作内容），自动缩小字号
  名字安全区    ：按 SKU 配置，再与 19.5–(84 或 90) 求交；避让图标、二维码
  提醒 84–90    ：连单提醒、核对提示（红色）
  页脚 90–100   ：左下 处理日期 / 中 店铺、数量、全局编号 / 右下 二维码
"""

import base64
import io
import json
import logging
import os
import sys
import tempfile
import traceback
import unicodedata
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s', stream=sys.stderr)
logger = logging.getLogger('basket_order_generator')

SLIDE_W_IN = 11.69
SLIDE_H_IN = 8.27
PT_PER_IN = 72.0
SLIDE_W = SLIDE_W_IN * PT_PER_IN
SLIDE_H = SLIDE_H_IN * PT_PER_IN

ZONES = {
    'header': (2, 1.5, 98, 8),
    'details': (2, 8.5, 98, 19.5),
    'notice': (2, 84, 88, 90),
    'footer': (2, 90.5, 88, 98.5),
    'qr': (89.7, 85.5, 98.3, 97.6),
}
CONTENT_TOP = 19.5
CONTENT_BOTTOM_WITH_NOTICE = 84
CONTENT_BOTTOM = 90
DEFAULT_AREA = {'x1': 5, 'x2': 95, 'y1': 20, 'y2': 84}
TECH_MIN_FONT = 24
WIDTH_SAFETY = 1.03
NAME_ICON_GAP_PT = 10


def pct_rect(x1, y1, x2, y2):
    return (x1 / 100.0 * SLIDE_W, y1 / 100.0 * SLIDE_H, x2 / 100.0 * SLIDE_W, y2 / 100.0 * SLIDE_H)


def rect_intersects(a, b, tol=0.5):
    return not (a[2] <= b[0] + tol or b[2] <= a[0] + tol or a[3] <= b[1] + tol or b[3] <= a[1] + tol)


def rect_inside(inner, outer, tol=0.5):
    return inner[0] >= outer[0] - tol and inner[1] >= outer[1] - tol and inner[2] <= outer[2] + tol and inner[3] <= outer[3] + tol


def norm_font_key(name):
    return ''.join(ch for ch in str(name or '').lower() if ch.isalnum())


# ------------------------------------------------------------------ 字体

class FontRegistry:
    """字体只从 fonts 表（上传的字体文件）解析，不回退到系统字体；找不到就是系统异常。"""

    def __init__(self, fonts):
        self.entries = []
        for f in fonts or []:
            path = normalize_path(f.get('path'))
            self.entries.append({'name': f.get('name') or '', 'path': path})
        self._family_cache = {}
        self._pil_cache = {}
        self._cmap_cache = {}
        self._metrics_cache = {}

    def _family_names(self, path):
        if path in self._family_cache:
            return self._family_cache[path]
        names = set()
        try:
            from fontTools.ttLib import TTFont
            tt = TTFont(path, lazy=True, fontNumber=0)
            for rec in tt['name'].names:
                if rec.nameID in (1, 4, 16):
                    try:
                        names.add(rec.toUnicode())
                    except Exception:
                        pass
            tt.close()
        except Exception:
            pass
        self._family_cache[path] = names
        return names

    def resolve(self, name):
        """返回 (path, family_name)；找不到返回 (None, None)"""
        key = norm_font_key(name)
        if not key:
            return None, None
        for e in self.entries:
            if norm_font_key(e['name']) == key and e['path']:
                return e['path'], self.family_name(e['path']) or e['name']
        for e in self.entries:
            if not e['path']:
                continue
            for fam in self._family_names(e['path']):
                if norm_font_key(fam) == key:
                    return e['path'], self.family_name(e['path']) or fam
        return None, None

    def family_name(self, path):
        try:
            from fontTools.ttLib import TTFont
            tt = TTFont(path, lazy=True, fontNumber=0)
            fam = tt['name'].getDebugName(16) or tt['name'].getDebugName(1)
            tt.close()
            return fam
        except Exception:
            return None

    def pil(self, path, size):
        from PIL import ImageFont
        key = (path, int(round(size * 4)))
        if key not in self._pil_cache:
            self._pil_cache[key] = ImageFont.truetype(path, max(1, int(round(size * 4))))
        return self._pil_cache[key]

    def cmap(self, path):
        if path not in self._cmap_cache:
            from fontTools.ttLib import TTFont
            tt = TTFont(path, lazy=True, fontNumber=0)
            self._cmap_cache[path] = set(tt.getBestCmap().keys())
            tt.close()
        return self._cmap_cache[path]

    def line_height_em(self, path):
        if path not in self._metrics_cache:
            from fontTools.ttLib import TTFont
            tt = TTFont(path, lazy=True, fontNumber=0)
            upm = float(tt['head'].unitsPerEm)
            hhea = tt['hhea']
            h1 = (hhea.ascent - hhea.descent + hhea.lineGap) / upm
            h2 = 0
            if 'OS/2' in tt:
                os2 = tt['OS/2']
                h2 = (os2.usWinAscent + os2.usWinDescent) / upm
            tt.close()
            self._metrics_cache[path] = max(1.15, h1, h2)
        return self._metrics_cache[path]

    def text_width(self, path, text, size):
        if not text:
            return 0.0
        font = self.pil(path, size)
        return font.getlength(text) / 4.0


def normalize_path(file_path):
    if not file_path:
        return ''
    p = str(file_path).strip()
    if not p:
        return ''
    if os.path.isabs(p) and os.path.exists(p):
        return p
    if p.startswith('/'):
        p = p[1:]
    for cand in (p, os.path.join(os.getcwd(), p)):
        if cand and os.path.exists(cand):
            return cand
    return ''


def is_special_char(ch):
    """重音 / 非 ASCII 字母和 & 走特殊字符字体（Calibri）"""
    if ch == '&':
        return True
    if ord(ch) < 128:
        return False
    return unicodedata.category(ch).startswith('L') or unicodedata.category(ch).startswith('M')


def has_special(text):
    return any(is_special_char(ch) for ch in text or '')


# ------------------------------------------------------------------ 名字测量

class NameFitError(Exception):
    def __init__(self, code, message, system=False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.system = system


def split_runs(text, main_path, special_path, mode, registry):
    """按字符切分 run：('main'|'special', 文字)"""
    runs = []
    main_cmap = registry.cmap(main_path)
    for ch in text:
        special = False
        if special_path and is_special_char(ch):
            special = True if mode == 'always' else (ord(ch) not in main_cmap)
        kind = 'special' if special else 'main'
        if runs and runs[-1][0] == kind:
            runs[-1] = (kind, runs[-1][1] + ch)
        else:
            runs.append((kind, ch))
    return runs


def run_size(kind, text, size, amp_delta):
    if kind == 'special' and text == '&':
        return max(1.0, size - amp_delta)
    return size


def measure_line(runs, size, fonts, registry, amp_delta):
    width = 0.0
    for kind, txt in runs:
        path = fonts[kind]
        # & 单独小一号；其他特殊字符与基准字号相同
        parts = []
        buf = ''
        for ch in txt:
            if ch == '&' and kind == 'special':
                if buf:
                    parts.append(buf)
                    buf = ''
                parts.append('&')
            else:
                buf += ch
        if buf:
            parts.append(buf)
        for part in parts:
            width += registry.text_width(path, part, run_size(kind, part, size, amp_delta))
    return width * WIDTH_SAFETY


def candidate_line_sets(text, allow_two):
    yield [text]
    if allow_two:
        words = text.split(' ')
        if len(words) >= 2:
            splits = []
            for i in range(1, len(words)):
                splits.append([' '.join(words[:i]), ' '.join(words[i:])])
            yield splits  # 由调用方挑最平衡的


def fit_name(spec, registry, obstacles, notice_present):
    """返回排版结果 dict；放不下时抛 NameFitError"""
    name = spec.get('name') or {}
    text = name.get('text') or ''
    if not text.strip():
        raise NameFitError('no_name', '没有名字')
    layout = name.get('layout') or {}
    special_cfg = name.get('special') or {}

    font_name = name.get('font') or ''
    main_path, main_family = registry.resolve(font_name)
    if not main_path:
        raise NameFitError('font_missing', f'字体 "{font_name or "(未配置)"}" 在字体库中找不到对应文件（系统异常，不是顾客名字做不了）', True)
    need_special = has_special(text)
    special_path, special_family = (None, None)
    if need_special:
        special_path, special_family = registry.resolve(special_cfg.get('font') or 'Calibri')
        if not special_path:
            raise NameFitError('font_missing', f'特殊字符字体 "{special_cfg.get("font") or "Calibri"}" 在字体库中找不到（系统异常）', True)
    mode = special_cfg.get('mode') or 'always'
    amp_delta = float(special_cfg.get('ampersandSizeDelta') or 10)

    try:
        runs = split_runs(text, main_path, special_path, mode, registry)
    except Exception as e:
        raise NameFitError('font_measure_failed', f'读取字体文件失败：{e}', True)
    fonts = {'main': main_path, 'special': special_path or main_path}
    # 缺字检查：不静默替换
    missing = []
    for kind, txt in runs:
        cmap = registry.cmap(fonts[kind])
        for ch in txt:
            if ch.isspace():
                continue
            if ord(ch) not in cmap:
                missing.append(ch)
    if missing:
        raise NameFitError('glyph_missing', f'字体缺字：{"".join(sorted(set(missing)))}（{font_name}），请更换字体或确认', True)

    area_cfg = layout.get('area') or DEFAULT_AREA
    try:
        x1, x2, y1, y2 = float(area_cfg['x1']), float(area_cfg['x2']), float(area_cfg['y1']), float(area_cfg['y2'])
    except Exception:
        raise NameFitError('area_invalid', '名字区域配置格式错误', True)
    if not (0 <= x1 < x2 <= 100 and 0 <= y1 < y2 <= 100):
        raise NameFitError('area_invalid', f'名字区域配置无效：x{x1}-{x2} y{y1}-{y2}', True)
    bottom_limit = CONTENT_BOTTOM_WITH_NOTICE if notice_present else CONTENT_BOTTOM
    ey1 = max(y1, CONTENT_TOP)
    ey2 = min(y2, bottom_limit)
    if ey2 - ey1 < 5:
        raise NameFitError('area_invalid', f'名字区域与订单详情 / 提醒区重叠后剩余高度不足（y{y1}-{y2}）', True)
    area = list(pct_rect(x1, ey1, x2, ey2))
    buffer = float(layout.get('bufferPt') or 0)
    if buffer:
        area = [area[0] + buffer, area[1] + buffer, area[2] - buffer, area[3] - buffer]

    max_size = layout.get('maxFontSize') or name.get('legacyFontSize') or 200
    preferred = layout.get('preferredFontSize')
    start = float(preferred or max_size)
    min_size = float(layout.get('minFontSize') or TECH_MIN_FONT)
    allow_two = bool(layout.get('allowTwoLines'))

    annotation = None
    ann_cfg = special_cfg.get('annotation') or {}
    if need_special and ann_cfg.get('enabled'):
        ann_path, ann_family = registry.resolve(ann_cfg.get('font') or 'Calibri')
        if not ann_path:
            raise NameFitError('font_missing', f'标注字体 "{ann_cfg.get("font") or "Calibri"}" 在字体库中找不到（系统异常）', True)
        ann_size = float(ann_cfg.get('fontSize') or 40)
        ann_w = registry.text_width(ann_path, text, ann_size) * WIDTH_SAFETY
        ann_h = registry.line_height_em(ann_path) * ann_size
        annotation = {'text': text, 'size': ann_size, 'w': ann_w, 'h': ann_h, 'family': ann_family or 'Calibri'}

    rel_slots = [i for i in (spec.get('icons') or []) if (i.get('slot') or {}).get('anchor') in ('name_left', 'name_right')]
    rel_left = [i for i in rel_slots if i['slot']['anchor'] == 'name_left']
    rel_right = [i for i in rel_slots if i['slot']['anchor'] == 'name_right']

    lh_em = max(registry.line_height_em(main_path), registry.line_height_em(fonts['special']) if need_special else 0)
    aw = area[2] - area[0]
    ah = area[3] - area[1]

    def try_layout(lines, size):
        widths = [measure_line(split_runs(l, main_path, special_path, mode, registry), size, fonts, registry, amp_delta) for l in lines]
        icon_side = 0.0
        rel_size = 0.0
        if rel_slots:
            rel_size = max(float(i['slot'].get('size') or 15) for i in rel_slots) / 100.0 * SLIDE_H
            icon_side = rel_size + NAME_ICON_GAP_PT
        left_extra = icon_side * len(rel_left)
        right_extra = icon_side * len(rel_right)
        block_w = max(widths) + left_extra + right_extra
        line_h = lh_em * size
        text_h = line_h * len(lines)
        block_h = text_h + ((annotation['h'] + 4) if annotation else 0)
        block_h = max(block_h, rel_size if rel_slots else 0)
        if block_w > aw or block_h > ah or (annotation and annotation['w'] > aw):
            return None
        for cx, top in placements(block_w, block_h):
            placed = place(lines, size, widths, block_w, block_h, cx, top, line_h, left_extra, right_extra, icon_side, rel_size)
            if placed:
                return placed
        return None

    def placements(block_w, block_h):
        # 先居中；与图标重叠时再尝试靠上 / 靠下、靠左 / 靠右（都在安全区内）
        xs = [(area[0] + area[2]) / 2.0, area[0] + block_w / 2.0, area[2] - block_w / 2.0]
        ys = [area[1] + (ah - block_h) / 2.0, area[1], area[3] - block_h]
        seen = set()
        for y in ys:
            for x in xs:
                k = (round(x, 1), round(y, 1))
                if k not in seen:
                    seen.add(k)
                    yield x, y

    def place(lines, size, widths, block_w, block_h, cx, top, line_h, left_extra, right_extra, icon_side, rel_size):
        boxes = []
        ann_box = None
        if annotation:
            ann_box = (cx - annotation['w'] / 2, top, cx + annotation['w'] / 2, top + annotation['h'])
            top += annotation['h'] + 4
        text_cx = cx + (left_extra - right_extra) / 2.0
        line_boxes = []
        for i, w in enumerate(widths):
            ly = top + i * line_h
            line_boxes.append((text_cx - w / 2, ly, text_cx + w / 2, ly + line_h))
        name_box = (min(b[0] for b in line_boxes), line_boxes[0][1], max(b[2] for b in line_boxes), line_boxes[-1][3])
        icon_boxes = []
        if rel_slots:
            iy = name_box[1] + (name_box[3] - name_box[1] - rel_size) / 2.0
            lx = name_box[0] - NAME_ICON_GAP_PT
            for _ in rel_left:
                icon_boxes.append((lx - rel_size, iy, lx, iy + rel_size))
                lx -= icon_side
            rx = name_box[2] + NAME_ICON_GAP_PT
            for _ in rel_right:
                icon_boxes.append((rx, iy, rx + rel_size, iy + rel_size))
                rx += icon_side
        boxes = line_boxes + ([ann_box] if ann_box else []) + icon_boxes
        for b in boxes:
            if not rect_inside(b, (0, 0, SLIDE_W, SLIDE_H)):
                return None
            for ob in obstacles:
                if rect_intersects(b, ob):
                    return None
        return {
            'fontSize': round(size, 1), 'lines': lines, 'lineWidths': [round(w, 1) for w in widths],
            'lineHeight': line_h, 'lineBoxes': line_boxes, 'nameBox': name_box, 'annotationBox': ann_box,
            'relIconBoxes': icon_boxes, 'area': area,
        }

    size_steps = []
    s = start
    while s >= min_size - 1e-6:
        size_steps.append(s)
        s -= 1.0
    if not size_steps:
        size_steps = [min_size]

    # 优先单行：先在所有字号上试单行，放不下再试双行
    for size in size_steps:
        r = try_layout([text], size)
        if r:
            r.update({'twoLines': False})
            break
    else:
        r = None
        if allow_two and ' ' in text.strip():
            words = text.split(' ')
            splits = [[' '.join(words[:i]), ' '.join(words[i:])] for i in range(1, len(words))]
            for size in size_steps:
                best = None
                for lines in splits:
                    cand = try_layout(lines, size)
                    if cand and (best is None or max(cand['lineWidths']) < max(best['lineWidths'])):
                        best = cand
                if best:
                    r = best
                    r.update({'twoLines': True})
                    break
    if not r:
        single_min_w = measure_line(runs, min_size, fonts, registry, amp_delta)
        raise NameFitError(
            'name_not_fit',
            f'名字 "{text}" 在安全区内放不下：最小 {min_size:g}pt 时宽 {single_min_w:.0f}pt，区域宽 {aw:.0f}pt、高 {ah:.0f}pt'
            + ('（不允许换行）' if not allow_two else '') + '，请核对排版或区域配置',
        )
    r.update({
        'lineRuns': [split_runs(l, main_path, special_path, mode, registry) for l in r['lines']],
        'mainFamily': main_family or font_name,
        'specialFamily': special_family,
        'mainPath': main_path,
        'ampDelta': amp_delta,
        'annotation': annotation,
        'needSpecial': need_special,
    })
    return r


# ------------------------------------------------------------------ 每页计划

def slot_box(slot):
    x, y, w, h = float(slot.get('x') or 0), float(slot.get('y') or 0), float(slot.get('w') or 0), float(slot.get('h') or 0)
    return pct_rect(x, y, x + w, y + h)


def fit_image_box(path, box):
    from PIL import Image
    with Image.open(path) as im:
        iw, ih = im.size
    bw, bh = box[2] - box[0], box[3] - box[1]
    scale = min(bw / iw, bh / ih)
    w, h = iw * scale, ih * scale
    x = box[0] + (bw - w) / 2
    y = box[1] + (bh - h) / 2
    return (x, y, x + w, y + h)


def fixed_obstacles(notice_present):
    obs = [pct_rect(*ZONES['header']), pct_rect(*ZONES['details']), pct_rect(*ZONES['qr']), pct_rect(*ZONES['footer'])]
    if notice_present:
        obs.append(pct_rect(*ZONES['notice']))
    return obs


def plan_slide(spec, registry):
    result = {'key': spec.get('key'), 'ok': True, 'errors': [], 'icons': []}
    if spec.get('kind') == 'placeholder':
        return result
    notice_present = bool(spec.get('reminder') or spec.get('staticReminder') or spec.get('warnings'))
    obstacles = fixed_obstacles(notice_present)
    abs_boxes = []
    for icon in spec.get('icons') or []:
        slot = icon.get('slot') or {}
        path = normalize_path(icon.get('path'))
        entry = {'iconName': icon.get('iconName'), 'slot': slot.get('key'), 'path': icon.get('path')}
        if not path:
            result['errors'].append({'code': 'icon_asset_missing', 'message': f'图标 {icon.get("iconName")} 素材文件不存在', 'system': True})
            result['icons'].append(entry)
            continue
        try:
            from PIL import Image
            with Image.open(path) as im:
                im.verify()
        except Exception as e:
            result['errors'].append({'code': 'icon_unreadable', 'message': f'图标 {icon.get("iconName")} 素材无法读取：{e}', 'system': True})
            result['icons'].append(entry)
            continue
        if slot.get('anchor', 'absolute') == 'absolute':
            box = fit_image_box(path, slot_box(slot))
            for ob in obstacles:
                if rect_intersects(box, ob):
                    result['errors'].append({'code': 'layout_slot_overlap', 'message': f'图标位置 {slot.get("key")} 与页面固定区域重叠', 'system': True})
                    break
            for other in abs_boxes:
                if rect_intersects(box, other):
                    result['errors'].append({'code': 'layout_slot_overlap', 'message': f'图标位置 {slot.get("key")} 与其他图标重叠', 'system': True})
                    break
            abs_boxes.append(box)
            entry['box'] = box
        result['icons'].append(entry)
    try:
        fit = fit_name(spec, registry, obstacles + abs_boxes, notice_present)
        result['name'] = {
            'fontSize': fit['fontSize'], 'lines': fit['lines'], 'twoLines': fit['twoLines'], 'nameBox': fit['nameBox'],
            'annotationBox': fit['annotationBox'], 'mainFamily': fit['mainFamily'], 'specialFamily': fit['specialFamily'],
            'area': fit['area'],
        }
        result['_fit'] = fit
    except NameFitError as e:
        result['errors'].append({'code': e.code, 'message': e.message, 'system': e.system})
    except Exception as e:
        result['errors'].append({'code': 'font_measure_failed', 'message': f'名字测量失败：{e}', 'system': True})
    result['ok'] = not result['errors']
    return result


# ------------------------------------------------------------------ 渲染

def emu(pt):
    from pptx.util import Pt
    return int(Pt(pt))


def add_text(slide, box, text, size, color=(0, 0, 0), bold=False, align='left', font=None, wrap=True, anchor='top'):
    from pptx.util import Pt
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
    tb = slide.shapes.add_textbox(emu(box[0]), emu(box[1]), emu(box[2] - box[0]), emu(box[3] - box[1]))
    tf = tb.text_frame
    tf.word_wrap = wrap
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = {'top': MSO_ANCHOR.TOP, 'middle': MSO_ANCHOR.MIDDLE, 'bottom': MSO_ANCHOR.BOTTOM}[anchor]
    lines = text.split('\n') if isinstance(text, str) else text
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = {'left': PP_ALIGN.LEFT, 'center': PP_ALIGN.CENTER, 'right': PP_ALIGN.RIGHT}[align]
        r = p.add_run()
        r.text = line
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.color.rgb = RGBColor(*color)
        if font:
            r.font.name = font
    return tb


def fit_text_size(registry, family_path, lines, box, max_size, min_size, wrap_width=True):
    """订单详情 / 提醒等长文本：按宽度折行后从大到小找能放下的字号。返回 (size, wrapped_lines, truncated)"""
    w = box[2] - box[0]
    h = box[3] - box[1]
    size = max_size
    while size >= min_size:
        wrapped = []
        for line in lines:
            wrapped.extend(wrap_line(registry, family_path, line, size, w) if family_path else [line])
        if len(wrapped) * size * 1.22 <= h:
            return size, wrapped, False
        size -= 0.5
    wrapped = []
    for line in lines:
        wrapped.extend(wrap_line(registry, family_path, line, min_size, w) if family_path else [line])
    max_lines = max(1, int(h // (min_size * 1.22)))
    if len(wrapped) > max_lines:
        wrapped = wrapped[:max_lines]
        wrapped[-1] = wrapped[-1][: max(0, len(wrapped[-1]) - 14)] + '…（完整内容见系统明细）'
        return min_size, wrapped, True
    return min_size, wrapped, False


def wrap_line(registry, path, line, size, width):
    out = []
    current = ''
    for ch in line:
        trial = current + ch
        if registry.text_width(path, trial, size) * 1.05 > width and current:
            # 尽量在空格处断开
            cut = current.rfind(' ')
            if cut > len(current) * 0.5:
                out.append(current[:cut])
                current = current[cut + 1:] + ch
            else:
                out.append(current)
                current = ch
        else:
            current = trial
    out.append(current)
    return out


def render_slide(prs, spec, plan, registry, qr_cache):
    from pptx.util import Pt
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

    slide = prs.slides.add_slide(prs.slide_layouts[6])
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = RGBColor(255, 255, 255)
    report = {'key': spec.get('key'), 'iconsExpected': 0, 'iconsInserted': 0, 'iconErrors': [], 'nameRendered': False, 'shapes': []}
    detail_path, _ = registry.resolve('Calibri')

    hx1, hy1, hx2, hy2 = pct_rect(*ZONES['header'])
    add_text(slide, (hx1, hy1, hx1 + (hx2 - hx1) * 0.24, hy2), spec.get('orderDate') or '', 16, anchor='middle', wrap=False).name = 'order-date'
    title = spec.get('title') or ''
    tsize, tlines, _ = fit_text_size(registry, detail_path, [title], (hx1 + (hx2 - hx1) * 0.25, hy1, hx1 + (hx2 - hx1) * 0.84, hy2), 18, 9)
    add_text(slide, (hx1 + (hx2 - hx1) * 0.25, hy1, hx1 + (hx2 - hx1) * 0.84, hy2), '\n'.join(tlines), tsize, align='center', anchor='middle').name = 'title'
    add_text(slide, (hx1 + (hx2 - hx1) * 0.85, hy1, hx2, hy2), spec.get('groupPosition') or '', 22, bold=True, align='right', anchor='middle', wrap=False,
             color=(200, 0, 0) if spec.get('kind') == 'placeholder' else (0, 0, 0)).name = 'group-position'

    dbox = pct_rect(*ZONES['details'])
    dsize, dlines, _ = fit_text_size(registry, detail_path, spec.get('details') or [], dbox, 13, 7)
    add_text(slide, dbox, '\n'.join(dlines), dsize).name = 'details'

    if spec.get('kind') == 'placeholder':
        ph = spec.get('placeholder') or {}
        body = [ph.get('title') or '待核对：本行不可制作'] + ['· ' + r for r in (ph.get('reasons') or [])]
        box = pct_rect(5, 22, 95, 82)
        psize, plines, _ = fit_text_size(registry, detail_path, body, box, 28, 12)
        add_text(slide, box, '\n'.join(plines), psize, color=(220, 0, 0), bold=True).name = 'placeholder'
    else:
        fit = (plan or {}).get('_fit')
        # 图标：三段校验的第三段，记录实际插入数
        for icon in spec.get('icons') or []:
            report['iconsExpected'] += 1
            path = normalize_path(icon.get('path'))
            slot = icon.get('slot') or {}
            try:
                if not path:
                    raise FileNotFoundError(icon.get('path'))
                anchor = slot.get('anchor', 'absolute')
                if anchor == 'absolute':
                    box = fit_image_box(path, slot_box(slot))
                else:
                    rel = (fit or {}).get('relIconBoxes') or []
                    rel_icons = [i for i in spec.get('icons') if (i.get('slot') or {}).get('anchor') in ('name_left', 'name_right')]
                    idx = rel_icons.index(icon)
                    lefts = [i for i in rel_icons if i['slot']['anchor'] == 'name_left']
                    ordered = lefts + [i for i in rel_icons if i['slot']['anchor'] == 'name_right']
                    box = fit_image_box(path, rel[ordered.index(icon)])
                pic = slide.shapes.add_picture(path, emu(box[0]), emu(box[1]), emu(box[2] - box[0]), emu(box[3] - box[1]))
                pic.name = f'icon:{icon.get("iconName")}'
                report['iconsInserted'] += 1
            except Exception as e:
                report['iconErrors'].append(f'{icon.get("iconName")}: {e}')
        if fit:
            if fit.get('annotation') and fit.get('annotationBox'):
                ab = fit['annotationBox']
                tb = add_text(slide, ab, fit['annotation']['text'], fit['annotation']['size'], color=(220, 0, 0), align='center', font=fit['annotation']['family'], wrap=False)
                tb.name = 'name-annotation'
            for i, line in enumerate(fit['lines']):
                lb = fit['lineBoxes'][i]
                tb = slide.shapes.add_textbox(emu(lb[0]), emu(lb[1]), emu(lb[2] - lb[0]), emu(lb[3] - lb[1]))
                tb.name = 'name' if len(fit['lines']) == 1 else f'name-line-{i + 1}'
                tf = tb.text_frame
                tf.word_wrap = False
                tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
                tf.vertical_anchor = MSO_ANCHOR.TOP
                p = tf.paragraphs[0]
                p.alignment = PP_ALIGN.CENTER
                p.line_spacing = Pt(fit['lineHeight'])
                for kind, txt in fit['lineRuns'][i]:
                    # & 单独成 run 并小 ampDelta pt
                    pieces = []
                    if kind == 'special':
                        buf = ''
                        for ch in txt:
                            if ch == '&':
                                if buf:
                                    pieces.append(buf)
                                    buf = ''
                                pieces.append('&')
                            else:
                                buf += ch
                        if buf:
                            pieces.append(buf)
                    else:
                        pieces = [txt]
                    for piece in pieces:
                        r = p.add_run()
                        r.text = piece
                        r.font.size = Pt(run_size(kind, piece, fit['fontSize'], fit['ampDelta']))
                        r.font.name = fit['specialFamily'] if kind == 'special' else fit['mainFamily']
                        r.font.color.rgb = RGBColor(0, 0, 0)  # 名字默认黑色
                report['nameRendered'] = True
            if fit.get('twoLines') and (spec.get('name') or {}).get('layout', {}).get('twoLineNote'):
                nb = fit['nameBox']
                add_text(slide, (nb[0], max(nb[1] - 22, pct_rect(0, CONTENT_TOP, 0, 0)[1]), nb[2], max(nb[1] - 2, pct_rect(0, CONTENT_TOP, 0, 0)[1] + 20)),
                         spec['name']['layout']['twoLineNote'], 14, color=(220, 0, 0), align='center').name = 'two-line-note'

    # 提醒区：连单提醒 + 核对提示（红色）
    notices = []
    if spec.get('staticReminder'):
        notices.append('提醒：' + spec['staticReminder'])
    if spec.get('reminder'):
        notices.append(spec['reminder'])
    for w in spec.get('warnings') or []:
        notices.append('⚠ ' + w)
    if notices:
        nbox = pct_rect(*ZONES['notice'])
        nsize, nlines, _ = fit_text_size(registry, detail_path, notices, nbox, 16, 8)
        tb = add_text(slide, nbox, '\n'.join(nlines), nsize, color=(220, 0, 0), bold=True)
        tb.name = 'notice'

    fx1, fy1, fx2, fy2 = pct_rect(*ZONES['footer'])
    add_text(slide, (fx1, fy1, fx1 + (fx2 - fx1) * 0.3, fy2), spec.get('processDate') or '', 14, anchor='bottom', wrap=False).name = 'process-date'
    footer = ' | '.join(x for x in [spec.get('shopName') or '', spec.get('quantityText') or '', spec.get('globalNumber') or ''] if x)
    add_text(slide, (fx1 + (fx2 - fx1) * 0.32, fy1, fx2, fy2), footer, 14, align='right', anchor='bottom', wrap=False).name = 'footer'

    order_id = spec.get('qr') or ''
    if order_id:
        try:
            if order_id not in qr_cache:
                import qrcode
                qr = qrcode.QRCode(version=1, error_correction=qrcode.constants.ERROR_CORRECT_L, box_size=10, border=4)
                qr.add_data(str(order_id))
                qr.make(fit=True)
                buf = io.BytesIO()
                qr.make_image(fill_color='black', back_color='white').save(buf, format='PNG')
                qr_cache[order_id] = buf.getvalue()
            qx1, qy1, qx2, qy2 = pct_rect(*ZONES['qr'])
            side = min(qx2 - qx1, qy2 - qy1)
            pic = slide.shapes.add_picture(io.BytesIO(qr_cache[order_id]), emu(qx2 - side), emu(qy2 - side), emu(side), emu(side))
            pic.name = 'qr'
        except Exception as e:
            logger.error(f'二维码生成失败：{e}')
    return report


# ------------------------------------------------------------------ 入口

def handle(request):
    registry = FontRegistry(request.get('fonts') or [])
    mode = request.get('mode') or 'render'
    slides = request.get('slides') or []
    plans = [plan_slide(spec, registry) for spec in slides]
    if mode == 'plan':
        return {'success': True, 'mode': 'plan', 'slides': [{k: v for k, v in p.items() if k != '_fit'} for p in plans]}

    from pptx import Presentation
    from pptx.util import Inches
    prs = Presentation()
    prs.slide_width = Inches(SLIDE_W_IN)
    prs.slide_height = Inches(SLIDE_H_IN)
    reports = []
    errors = []
    qr_cache = {}
    for spec, plan in zip(slides, plans):
        try:
            if spec.get('kind') != 'placeholder' and not plan.get('ok'):
                # 计划阶段失败的页不应该进入渲染；兜底按占位页处理
                spec = dict(spec)
                spec['kind'] = 'placeholder'
                spec['groupPosition'] = '待核对'
                spec['placeholder'] = {'title': '待核对：排版失败，不可制作', 'reasons': [e['message'] for e in plan['errors']]}
            reports.append(render_slide(prs, spec, plan, registry, qr_cache))
        except Exception as e:
            errors.append(f'slide {spec.get("key")}: {e}')
            logger.error(traceback.format_exc())
            reports.append({'key': spec.get('key'), 'error': str(e)})
    buf = io.BytesIO()
    prs.save(buf)
    return {
        'success': True,
        'mode': 'render',
        'slides_created': len(prs.slides),
        'data': base64.b64encode(buf.getvalue()).decode('ascii'),
        'reports': reports,
        'plans': [{k: v for k, v in p.items() if k != '_fit'} for p in plans],
        'errors': errors or None,
    }


def main():
    try:
        input_data = json.loads(sys.stdin.read())
        payload = input_data.get('orderData') or input_data.get('excelData')
        if not payload:
            print(json.dumps({'success': False, 'message': 'No data provided'}))
            return
        request = json.loads(base64.b64decode(payload).decode('utf-8'))
        if isinstance(request, list):
            print(json.dumps({'success': False, 'message': '旧版输入格式（每页数据数组）已不再支持，请使用 v2 请求'}))
            return
        result = handle(request)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'success': False, 'message': f'Error: {e}', 'error': traceback.format_exc()}))


if __name__ == '__main__':
    main()
