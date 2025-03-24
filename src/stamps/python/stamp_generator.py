#!/usr/bin/env python3
import sys
import json
import os
import base64
import time
import logging
from io import BytesIO
import svgwrite
from svgwrite import Drawing
from svgwrite.text import Text
from svgwrite.shapes import Rect
from PIL import Image
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
import cairo
import math
import uharfbuzz as hb
import re

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(levelname)s: %(message)s'
)
logger = logging.getLogger('stamp_generator')

class StampGenerator:
    def __init__(self, data):
        self.data = data
        self.template = data.get('template', {})
        self.text_elements = data.get('textElements', [])
        self.format = 'svg'  # 固定为SVG格式
        self.convert_text_to_paths = data.get('convertTextToPaths', False)
        self.width = self.template.get('width', 500)
        self.height = self.template.get('height', 500)
        self.background_image_path = self.template.get('backgroundImagePath', None)
        
        # Prepare output directory
        self.output_dir = os.path.join(os.getcwd(), 'uploads', 'stamps')
        os.makedirs(self.output_dir, exist_ok=True)
        
        # Map font families to font files
        self.font_map = self._build_font_map()
        
        # 初始化uharfbuzz缓存
        self.hb_fonts = {}

    def _build_font_map(self):
        """Build a mapping of font family names to font file paths"""
        font_map = {}
        
        # Default font as fallback
        default_fonts = [
            '/System/Library/Fonts/Arial.ttf',  # macOS
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',  # Linux
            'C:\\Windows\\Fonts\\arial.ttf'  # Windows
        ]
        
        # Find a working default font
        for font_path in default_fonts:
            if os.path.exists(font_path):
                font_map['Arial'] = font_path
                break
        
        # Scan the fonts directory for custom fonts
        fonts_dir = os.path.join(os.getcwd(), 'uploads', 'fonts')
        if os.path.exists(fonts_dir):
            for file in os.listdir(fonts_dir):
                if file.lower().endswith(('.ttf', '.otf')):
                    font_path = os.path.join(fonts_dir, file)
                    font_family = os.path.splitext(file)[0]
                    font_map[font_family] = font_path
                    
                    # Also register without hyphens if the name contains them
                    if '-' in font_family:
                        no_hyphen_name = font_family.replace('-', '')
                        font_map[no_hyphen_name] = font_path
                        
                        # 对于 Montserrat 系列字体的特殊处理
                        if font_family.startswith('Montserrat-'):
                            # 将所有 Montserrat 变体注册为 Montserrat 字体
                            font_map['Montserrat'] = font_path
        
        # 简化日志输出
        logger.debug(f"Available fonts: {list(font_map.keys())}")
        
        return font_map

    def _get_font_path(self, font_family):
        """Get the font file path for a given font family"""
        if font_family in self.font_map:
            return self.font_map[font_family]
            
        # 尝试使用不区分大小写的匹配
        for name in self.font_map:
            if name.lower() == font_family.lower():
                return self.font_map[name]
                    
        logger.warning(f"Font not found: {font_family}")
        return self.font_map.get('Arial')  # Default fallback

    def _generate_svg_cairo(self):
        """使用PyCairo和Pango生成SVG文件"""
        try:
            # 创建一个临时文件用于SVG输出
            svg_output = BytesIO()
            
            # 创建一个SVG表面
            surface = cairo.SVGSurface(svg_output, self.width, self.height)
            ctx = cairo.Context(surface)

            # 绘制文本元素
            for element in self.text_elements:
                try:
                    # 获取元素属性
                    text = element.get('value', '')
                    if not text:
                        continue
                    
                    # 从模板元素获取字体属性(如果可用)
                    template_element = next((t for t in self.template.get('textElements', []) 
                                           if t.get('id') == element.get('id')), {})
                    
                    font_family = element.get('fontFamily') or template_element.get('fontFamily', 'Arial')
                    font_size = element.get('fontSize') or template_element.get('fontSize', 16)
                    
                    # 获取位置
                    position = element.get('position') or template_element.get('position', {})
                    x = position.get('x', 10)
                    y = position.get('y', 10)
                    
                    # 获取颜色
                    color_str = element.get('color') or template_element.get('color', '#000000')
                    # 解析颜色字符串 (#RRGGBB 格式) 为 RGB 值 (0-1范围)
                    color = (
                        int(color_str[1:3], 16) / 255,
                        int(color_str[3:5], 16) / 255,
                        int(color_str[5:7], 16) / 255
                    )
                    
                    # 获取旋转
                    rotation = position.get('rotation', 0)
                    
                    # 获取文本对齐方式
                    text_align = position.get('textAlign', 'left')
                    vert_align = position.get('verticalAlign', 'baseline')
                    
                    # 使用Pango渲染文本以解决字母间距问题
                    self._render_with_advanced_cairo(ctx, text, font_family, font_size, x, y, color, rotation, text_align, vert_align)
                    
                except Exception as e:
                    logger.error(f"Error drawing text: {e}")
            
            # 完成SVG表面
            surface.finish()
            
            # 获取SVG内容
            svg_content = svg_output.getvalue().decode('utf-8')
            
            # 简化的调试输出
            logger.debug(f"Generated SVG: {len(svg_content)} bytes")
            
            return svg_content, None
            
        except Exception as e:
            return None, f"Error generating SVG: {e}"

    def _render_with_advanced_cairo(self, ctx, text, font_family, font_size, x, y, color, rotation, text_align, vert_align):
        """使用uharfbuzz处理字体间距并使用Cairo渲染文本"""
        try:
            # 保存当前状态用于旋转
            ctx.save()
            
            # 获取位置属性
            # 尝试获取circular text属性，如果存在的话
            circular_text = False
            radius = 0
            start_angle = 0
            end_angle = 360
            direction = 'clockwise'
            
            # 查找当前文本元素的属性
            for element in self.text_elements:
                if element.get('value') == text:
                    position = element.get('position', {})
                    circular_text = position.get('isCircular', False)
                    if circular_text:
                        radius = position.get('radius', 200)
                        start_angle = position.get('startAngle', 0)
                        end_angle = position.get('endAngle', 360)
                        direction = position.get('direction', 'clockwise')
                    break
            
            # 如果是普通文本，按照原来的方式处理
            if not circular_text:
                # 旋转 (如果需要)
                if rotation:
                    # 移动到旋转中心
                    ctx.translate(x, y)
                    # 旋转 (需要转换为弧度)
                    ctx.rotate(rotation * (math.pi / 180.0))
                    # 重置位置为原点
                    ctx.translate(-x, -y)
            
            # 获取字体文件路径
            font_path = self._get_font_path(font_family)
            
            # 设置颜色
            ctx.set_source_rgb(color[0], color[1], color[2])
            
            # 使用uharfbuzz进行排版
            try:
                # 从缓存中获取uharfbuzz字体对象，如果不存在则创建
                hb_font_key = (font_path, font_size)
                if hb_font_key not in self.hb_fonts:
                    # 创建blob和face
                    blob = hb.Blob.from_file_path(font_path)
                    face = hb.Face(blob)
                    
                    # 创建字体
                    font = hb.Font(face)
                    
                    # 设置缩放比例 (uharfbuzz自动处理缩放)
                    font.scale = (int(font_size * 64), int(font_size * 64))
                    
                    # 存入缓存
                    self.hb_fonts[hb_font_key] = font
                else:
                    font = self.hb_fonts[hb_font_key]
                
                # 创建Buffer
                buf = hb.Buffer()
                
                # 添加文本
                buf.add_str(text)
                
                # 设置buffer属性
                buf.direction = "ltr"  # 从左到右
                buf.script = "Latn"    # 拉丁文
                buf.language = "en"    # 英语
                
                # 应用字体排版 - 启用kerning
                features = {"kern": True, "liga": True}  # 启用字偶距和连字
                hb.shape(font, buf, features)
                
                # 获取排版信息
                infos = buf.glyph_infos
                positions = buf.glyph_positions
                
                # 计算整体宽度用于对齐
                total_width = sum(pos.x_advance for pos in positions) / 64.0
                
                # 如果是圆形文本，计算每个字符的间距角度
                if circular_text:
                    layout_mode = position.get('layoutMode', 'startAligned')  # 默认为起点对齐模式
                    base_angle = position.get('baseAngle', 0)  # 基准角度，默认为0度（正上方）
                    
                    # 根据字体大小计算每个字符的基础弧度间距（弧度 = 字体大小/半径）
                    char_angle = font_size / radius
                    
                    # 计算整体宽度（角度）
                    total_angle = char_angle * len(text)
                    
                    # 根据不同对齐模式确定起始角度
                    if layout_mode == 'centerAligned':
                        # 中心对齐模式：以base_angle为中心，向两侧均匀分布
                        # 计算整体文本角度宽度
                        total_text_angle = sum(pos.x_advance / 64.0 for pos in positions) / radius * (180 / math.pi)
                        # 修正：从base_angle减去半个文本宽度作为起始角度
                        start_angle = (base_angle - total_text_angle/2) % 360
                    else:
                        # 起点对齐模式：从base_angle开始
                        start_angle = base_angle
                    
                    # 当前角度
                    current_angle = start_angle
                    
                    # 渲染每个字符
                    for i, (info, pos) in enumerate(zip(infos, positions)):
                        # 获取当前字符的进阶量（以角度表示）
                        x_advance = pos.x_advance / 64.0
                        char_advance_angle = (x_advance / radius) * (180 / math.pi)
                        
                        # 计算字符在圆上的位置
                        angle_rad = current_angle * (math.pi / 180.0)
                        
                        # 计算字符在圆上的x,y坐标
                        glyph_x = x + radius * math.cos(angle_rad)
                        glyph_y = y + radius * math.sin(angle_rad)
                        
                        # 保存状态以便旋转
                        ctx.save()
                        
                        # 移动到字符位置
                        ctx.translate(glyph_x, glyph_y)
                        
                        # 计算字符旋转角度
                        rotation_angle = angle_rad + (math.pi / 2)
                        
                        # 应用旋转
                        ctx.rotate(rotation_angle)
                        
                        # 获取字符
                        cluster = info.cluster
                        glyph_char = text[cluster] if cluster < len(text) else ' '
                        
                        # 渲染字符
                        ctx.move_to(0, 0)
                        ctx.show_text(glyph_char)
                        
                        # 恢复状态
                        ctx.restore()
                        
                        # 更新角度为下一个字符
                        current_angle += char_advance_angle
                else:
                    # 获取可用宽度 - 根据旋转计算
                    padding = 50 # TODO 这里需要改成配置式或者根据字体大小自动计算
                    max_available_width = self.width - padding
                    if rotation % 180 != 0:  # 如果不是0度或180度
                        # 对于90度和270度附近的旋转，使用高度作为约束
                        if rotation % 180 > 45 and rotation % 180 < 135:
                            max_available_width = self.height
                    
                    # 计算缩放比例，如果文本宽度超出可用宽度
                    scale_factor = 1.0
                    if total_width > max_available_width:
                        scale_factor = max_available_width / total_width
                        # 应用缩放到字体大小
                        font_size = font_size * scale_factor
                        logger.debug(f"Scaling text '{text}' by factor {scale_factor}")
                        
                        # 创建新的scaled字体
                        if scale_factor < 1.0:
                            # 创建新的字体对象
                            blob = hb.Blob.from_file_path(font_path)
                            face = hb.Face(blob)
                            font = hb.Font(face)
                            font.scale = (int(font_size * 64), int(font_size * 64))
                            
                            # 重新排版
                            buf = hb.Buffer()
                            buf.add_str(text)
                            buf.direction = "ltr"
                            buf.script = "Latn"
                            buf.language = "en"
                            hb.shape(font, buf, features)
                            
                            # 更新信息
                            infos = buf.glyph_infos
                            positions = buf.glyph_positions
                            
                            # 重新计算总宽度
                            total_width = sum(pos.x_advance for pos in positions) / 64.0
                    
                    # 计算定位
                    place_x = x
                    place_y = y
                    
                    # 水平对齐
                    if text_align == 'center':
                        place_x = x - (total_width / 2)
                    elif text_align == 'right':
                        place_x = x - total_width
                    
                    # 计算垂直位置，需要字体的度量信息
                    ctx.select_font_face(font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                    ctx.set_font_size(font_size)
                    font_extents = ctx.font_extents()
                    
                    # 垂直对齐
                    if vert_align == 'top':
                        place_y = y + font_extents.ascent
                    elif vert_align == 'middle':
                        place_y = y + (font_extents.ascent - font_extents.descent) / 2
                    # baseline 是默认
                    
                    # 简化调试输出
                    logger.debug(f"Rendering '{text}' at ({place_x:.1f}, {place_y:.1f})")
                    
                    # 使用Cairo渲染每个字形
                    current_x = place_x
                    current_y = place_y
                    
                    # 创建字体上下文用于后续渲染
                    ctx.select_font_face(font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                    ctx.set_font_size(font_size)
                    
                    # 遍历所有字形并渲染
                    for i, (info, pos) in enumerate(zip(infos, positions)):
                        # 获取字符
                        # uharfbuzz不提供直接的字形到字符串的转换，所以我们使用原始字符
                        # 我们从文本的字符簇信息中获取对应的字符
                        cluster = info.cluster
                        # 根据字符簇找到原始字符（这里简化处理，可能对复杂文本不够准确）
                        glyph_char = text[cluster] if cluster < len(text) else ' '
                        
                        # 获取位置偏移 (需要转换单位)
                        x_offset = pos.x_offset / 64.0
                        y_offset = pos.y_offset / 64.0
                        x_advance = pos.x_advance / 64.0
                        
                        # 移动到绘制位置
                        glyph_x = current_x + x_offset
                        glyph_y = current_y - y_offset
                        
                        # 渲染字符
                        ctx.move_to(glyph_x, glyph_y)
                        ctx.show_text(glyph_char)
                        
                        # 更新位置
                        current_x += x_advance
                
            except Exception as hb_error:
                logger.warning(f"Using basic rendering: {hb_error}")
                # 回退到基本的渲染
                ctx.select_font_face(font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                ctx.set_font_size(font_size)
                
                # 检查是否为圆形文本
                if circular_text:
                    # 计算字体路径
                    layout_mode = position.get('layoutMode', 'startAligned')  # 默认为起点对齐模式
                    base_angle = position.get('baseAngle', 0)  # 基准角度，默认为0度（正上方）
                    
                    # 计算所有字符的总宽度
                    total_width = 0
                    for char in text:
                        char_extents = ctx.text_extents(char)
                        total_width += char_extents.x_advance
                    
                    # 计算总弧度（弧度 = 文本总宽度/半径）
                    total_angle = (total_width / radius) * (180 / math.pi)
                    
                    # 根据不同对齐模式确定起始角度
                    if layout_mode == 'centerAligned':
                        # 中心对齐模式：以base_angle为中心，向两侧均匀分布
                        # 计算整体文本角度宽度
                        total_text_angle = sum(pos.x_advance / 64.0 for pos in positions) / radius * (180 / math.pi)
                        # 修正：从base_angle减去半个文本宽度作为起始角度
                        start_angle = (base_angle - total_text_angle/2) % 360
                    else:
                        # 起点对齐模式：从base_angle开始
                        start_angle = base_angle
                    
                    # 当前角度
                    current_angle = start_angle
                    
                    # 渲染每个字符
                    for i, char in enumerate(text):
                        # 获取当前字符的宽度
                        char_extents = ctx.text_extents(char)
                        char_advance = char_extents.x_advance
                        
                        # 计算字符在圆上的位置 (使用当前角度 + 字符宽度的一半，让字符居中)
                        char_half_angle = (char_advance / 2 / radius) * (180 / math.pi)
                        angle_rad = (current_angle + char_half_angle) * (math.pi / 180.0)
                        
                        # 计算字符在圆上的x,y坐标
                        glyph_x = x + radius * math.cos(angle_rad)
                        glyph_y = y + radius * math.sin(angle_rad)
                        
                        # 保存状态以便旋转
                        ctx.save()
                        
                        # 移动到字符位置
                        ctx.translate(glyph_x, glyph_y)
                        
                        # 计算字符旋转角度
                        rotation_angle = angle_rad + (math.pi / 2)
                        
                        # 应用旋转
                        ctx.rotate(rotation_angle)
                        
                        # 渲染字符 (居中)
                        ctx.move_to(-char_extents.width / 2, 0)
                        ctx.show_text(char)
                        
                        # 恢复状态
                        ctx.restore()
                        
                        # 更新角度为下一个字符 (当前字符宽度对应的角度)
                        char_angle = (char_advance / radius) * (180 / math.pi)
                        current_angle += char_angle
                else:
                    # 获取文本尺寸
                    text_extents = ctx.text_extents(text)
                    text_width = text_extents.width
                    
                    # 检查文本是否超出可用空间并缩放
                    max_available_width = self.width
                    if rotation % 180 != 0:
                        if rotation % 180 > 45 and rotation % 180 < 135:
                            max_available_width = self.height
                    
                    # 如果宽度超出，缩放字体大小
                    if text_width > max_available_width:
                        scale_factor = max_available_width / text_width
                        font_size = font_size * scale_factor
                        logger.debug(f"Basic scaling by factor {scale_factor}")
                        
                        # 更新字体大小
                        ctx.set_font_size(font_size)
                        
                        # 重新计算尺寸
                        text_extents = ctx.text_extents(text)
                        text_width = text_extents.width
                    
                    # 计算定位
                    place_x = x
                    place_y = y
                    
                    # 水平对齐
                    if text_align == 'center':
                        place_x = x - (text_width / 2)
                    elif text_align == 'right':
                        place_x = x - text_width
                    
                    # 垂直对齐
                    font_extents = ctx.font_extents()
                    if vert_align == 'top':
                        place_y = y + font_extents.ascent
                    elif vert_align == 'middle':
                        place_y = y + (font_extents.ascent - font_extents.descent) / 2
                    
                    # 简单渲染文本
                    ctx.move_to(place_x, place_y)
                    ctx.show_text(text)
            
            # 恢复旋转前的状态
            ctx.restore()
                
        except Exception as e:
            logger.error(f"Rendering error: {e}")
            # 回退到最基本的文本渲染
            ctx.save()
            ctx.set_source_rgb(color[0], color[1], color[2])
            ctx.select_font_face(font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(font_size)
            ctx.move_to(x, y)
            ctx.show_text(text)
            ctx.restore()

    def generate(self):
        """Generate the stamp in SVG format"""
        # 只使用Cairo/Pango生成SVG
        data, error = self._generate_svg_cairo()
        if error:
            # 如果出现异常，尝试回退到svgwrite方法 (如果保留了该方法)
            logger.error(f"SVG generation error: {error}")
            return None, error
            
        # 如果有背景SVG，进行后期处理合并
        if self.background_image_path and self.background_image_path.lower().endswith('.svg'):
            full_bg_path = os.path.join(os.getcwd(), self.background_image_path)
            if os.path.exists(full_bg_path):
                try:
                    # 读取背景SVG
                    with open(full_bg_path, 'r') as f:
                        bg_svg = f.read()
                        
                    # 读取生成的SVG
                    svg_content = data
                    
                    # 简单合并：提取内容层并嵌入到背景中
                    # 尝试提取SVG内容中的元素
                    
                    # 提取背景SVG的基本信息
                    bg_width_match = re.search(r'width="([^"]*)"', bg_svg)
                    bg_height_match = re.search(r'height="([^"]*)"', bg_svg)
                    bg_width = bg_width_match.group(1) if bg_width_match else self.width
                    bg_height = bg_height_match.group(1) if bg_height_match else self.height
                    
                    # 从背景SVG中提取根元素属性
                    bg_svg_attrs_match = re.search(r'<svg([^>]*)>', bg_svg, re.DOTALL)
                    bg_svg_attrs = bg_svg_attrs_match.group(1) if bg_svg_attrs_match else ""
                    
                    # 从生成的SVG中提取内容部分 (在<svg>和</svg>之间)
                    content_match = re.search(r'<svg[^>]*>(.*?)</svg>', svg_content, re.DOTALL)
                    if content_match:
                        content = content_match.group(1)
                        
                        # 从生成的SVG中提取命名空间和其他属性
                        content_attrs_match = re.search(r'<svg([^>]*)>', svg_content, re.DOTALL)
                        content_attrs = content_attrs_match.group(1) if content_attrs_match else ""
                        
                        # 合并两个SVG的属性，确保所有命名空间都被包含
                        # 定义可能需要的命名空间
                        namespaces = {
                            'xmlns': 'http://www.w3.org/2000/svg',
                            'xmlns:xlink': 'http://www.w3.org/1999/xlink', 
                            'xmlns:svg': 'http://www.w3.org/2000/svg',
                            'xmlns:sodipodi': 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
                            'xmlns:inkscape': 'http://www.inkscape.org/namespaces/inkscape'
                        }
                        
                        # 从背景和内容属性中提取现有的命名空间
                        existing_namespaces = {}
                        for attr_str in [bg_svg_attrs, content_attrs]:
                            for ns, uri in namespaces.items():
                                ns_match = re.search(rf'{ns}="([^"]*)"', attr_str)
                                if ns_match:
                                    existing_namespaces[ns] = ns_match.group(1)
                                    
                        # 合并所有命名空间和宽高属性
                        merged_attrs = ""
                        for ns, uri in namespaces.items():
                            if ns in existing_namespaces:
                                merged_attrs += f' {ns}="{existing_namespaces[ns]}"'
                            elif (ns == 'xmlns:xlink' and 'xlink:href' in bg_svg + content) or \
                                 (ns == 'xmlns:sodipodi' and 'sodipodi:' in bg_svg + content) or \
                                 (ns == 'xmlns:inkscape' and 'inkscape:' in bg_svg + content) or \
                                 (ns == 'xmlns' or ns == 'xmlns:svg'):
                                merged_attrs += f' {ns}="{uri}"'
                        
                        # 添加宽度和高度属性
                        merged_attrs += f' width="{self.width}" height="{self.height}"'
                        
                        # 使用提取的内容创建一个新的SVG
                        merged_svg = f'<svg{merged_attrs}>{content}</svg>'
                        
                        # 将背景中的内容（不包括svg标签本身）合并到结果中
                        bg_content_match = re.search(r'<svg[^>]*>(.*?)</svg>', bg_svg, re.DOTALL)
                        if bg_content_match:
                            bg_content = bg_content_match.group(1)
                            # 在新SVG的开头插入背景内容
                            merged_svg = merged_svg.replace('>', '>' + bg_content, 1)
                        
                        # 使用合并后的SVG
                        data = merged_svg
                    else:
                        logger.warning("Could not extract content from generated SVG")
                except Exception as e:
                    logger.error(f"Error merging SVG with background: {e}")
                    # 继续使用原始生成的SVG
        
        return data, None

    def save_to_file(self, filename=None):
        """Save the generated stamp to a file"""
        if not filename:
            # Generate a unique filename
            timestamp = int(time.time())
            filename = f"stamp_{timestamp}.svg"
        
        # Generate the stamp
        data, error = self.generate()
        if error:
            return None, error
        
        # Save to file
        output_path = os.path.join(self.output_dir, filename)
        try:
            # SVG is text mode
            with open(output_path, 'w') as f:
                f.write(data)
            return f"/stamps/{filename}", None
        except Exception as e:
            return None, f"Error saving stamp to file: {e}"

def main():
    # Read JSON input from stdin
    try:
        input_data = json.loads(sys.stdin.read())
        
        # Create stamp generator
        generator = StampGenerator(input_data)
        
        # Check if we need to save to file
        if 'filename' in input_data:
            # Save to file and return URL
            url, error = generator.save_to_file(input_data['filename'])
            if error:
                print(json.dumps({'success': False, 'error': error}))
            else:
                print(json.dumps({'success': True, 'url': url}))
        else:
            # Generate and return data as base64
            data, error = generator.generate()
            if error:
                print(json.dumps({'success': False, 'error': error}))
            else:
                # For SVG, just use the string data directly
                encoded_data = base64.b64encode(data.encode('utf-8')).decode('utf-8')
                print(json.dumps({'success': True, 'data': encoded_data}))
                
    except Exception as e:
        # Return error as JSON
        print(json.dumps({'success': False, 'error': str(e)}))

if __name__ == "__main__":
    main() 