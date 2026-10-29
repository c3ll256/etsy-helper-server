#!/usr/bin/env python3
"""判断生成图是否为空白图：全透明，或可见像素全部接近白色。输出 {path: true/false/null}"""
import json
import sys

from PIL import Image


def is_blank(path):
    try:
        img = Image.open(path).convert('RGBA')
    except Exception:
        return None
    alpha = img.getchannel('A')
    if alpha.getbbox() is None:
        return True
    # 可见像素里有非白色的就不是空白
    rgb = Image.new('RGB', img.size, (255, 255, 255))
    rgb.paste(img, mask=alpha)
    gray = rgb.convert('L').point(lambda v: 255 if v < 245 else 0)
    return gray.getbbox() is None


def main():
    print(json.dumps({path: is_blank(path) for path in sys.argv[1:]}))


if __name__ == '__main__':
    main()
