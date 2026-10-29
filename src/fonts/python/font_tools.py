#!/usr/bin/env python3
"""
字体文件工具（供 NestJS 调用，输出 JSON）：
  split <collection.ttc> <out_dir> <prefix>   拆分 TTC / OTC 字体集合为单个字体文件
  inspect <font_file>                          读取字体名称、字形数量、是否含中文
"""
import json
import os
import sys

from fontTools.ttLib import TTFont
from fontTools.ttLib.ttCollection import TTCollection


def name_of(font, name_id):
    try:
        record = font['name'].getName(name_id, 3, 1, 0x409) or font['name'].getName(name_id, 1, 0, 0)
        return str(record) if record else None
    except Exception:
        return None


def describe(font):
    cmap = font.getBestCmap() or {}
    cjk = sum(1 for cp in cmap if 0x4E00 <= cp <= 0x9FFF)
    return {
        'family': name_of(font, 1),
        'subfamily': name_of(font, 2),
        'fullName': name_of(font, 4),
        'glyphCount': len(font.getGlyphOrder()),
        'cjkCount': cjk,
        'isCFF': 'CFF ' in font or 'CFF2' in font,
    }


def split(path, out_dir, prefix):
    collection = TTCollection(path)
    results = []
    for index, font in enumerate(collection.fonts):
        ext = 'otf' if ('CFF ' in font or 'CFF2' in font) else 'ttf'
        out_path = os.path.join(out_dir, f'{prefix}-{index}.{ext}')
        font.save(out_path)
        info = describe(font)
        info.update({'index': index, 'path': out_path, 'filename': os.path.basename(out_path)})
        results.append(info)
    return results


def main():
    try:
        command = sys.argv[1]
        if command == 'split':
            print(json.dumps({'success': True, 'fonts': split(sys.argv[2], sys.argv[3], sys.argv[4])}, ensure_ascii=False))
        elif command == 'inspect':
            with open(sys.argv[2], 'rb') as f:
                is_collection = f.read(4) == b'ttcf'
            font = TTFont(sys.argv[2], fontNumber=0) if is_collection else TTFont(sys.argv[2])
            info = describe(font)
            info['isCollection'] = is_collection
            print(json.dumps({'success': True, 'font': info}, ensure_ascii=False))
        else:
            raise ValueError(f'unknown command {command}')
    except Exception as e:
        print(json.dumps({'success': False, 'error': str(e)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
