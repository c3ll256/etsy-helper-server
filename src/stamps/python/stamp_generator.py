#!/usr/bin/env python3
import sys
import json
import os
import base64
import time
from io import BytesIO
import svgwrite
from svgwrite import Drawing
from svgwrite.text import Text
from svgwrite.shapes import Rect
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
import cairo

class StampGenerator:
    def __init__(self, data):
        self.data = data
        self.template = data.get('template', {})
        self.text_elements = data.get('textElements', [])
        self.format = data.get('format', 'png')
        self.convert_text_to_paths = data.get('convertTextToPaths', False)
        self.width = self.template.get('width', 500)
        self.height = self.template.get('height', 500)
        self.background_image_path = self.template.get('backgroundImagePath', None)
        
        # Prepare output directory
        self.output_dir = os.path.join(os.getcwd(), 'uploads', 'stamps')
        os.makedirs(self.output_dir, exist_ok=True)
        
        # Map font families to font files
        self.font_map = self._build_font_map()

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
        
        # 打印字体映射，便于调试（使用stderr而不是stdout）
        sys.stderr.write(f"Font map built: {list(font_map.keys())}\n")
        
        return font_map

    def _get_font_path(self, font_family):
        """Get the font file path for a given font family"""
        if font_family in self.font_map:
            return self.font_map[font_family]
            
        # 尝试使用不区分大小写的匹配
        for name in self.font_map:
            if name.lower() == font_family.lower():
                return self.font_map[name]
        
        # 对于 Montserrat 字体的特殊处理
        if font_family.lower() == 'montserrat':
            # 查找任何以 Montserrat- 开头的字体
            for name in self.font_map:
                if name.startswith('Montserrat-'):
                    return self.font_map[name]
                    
        sys.stderr.write(f"Font not found: {font_family}. Available fonts: {list(self.font_map.keys())}\n")
        return self.font_map.get('Arial')  # Default fallback

    def _rasterize(self):
        """Generate a raster image (PNG, JPEG)"""
        # Create a new image with the specified dimensions
        img = Image.new('RGBA', (self.width, self.height), color=(255, 255, 255, 255))
        draw = ImageDraw.Draw(img)
        
        # Add background image if specified
        if self.background_image_path:
            full_bg_path = os.path.join(os.getcwd(), self.background_image_path)
            if os.path.exists(full_bg_path):
                try:
                    bg_img = Image.open(full_bg_path).convert('RGBA')
                    bg_img = bg_img.resize((self.width, self.height))
                    img.paste(bg_img, (0, 0), bg_img)
                except Exception as e:
                    return None, f"Error loading background image: {e}"
        
        # Draw text elements
        for element in self.text_elements:
            try:
                # Get element properties
                text = element.get('value', '')
                if not text:
                    continue
                
                # Get font properties from template element if available
                template_element = next((t for t in self.template.get('textElements', []) 
                                       if t.get('id') == element.get('id')), {})
                
                font_family = element.get('fontFamily') or template_element.get('fontFamily', 'Arial')
                font_size = element.get('fontSize') or template_element.get('fontSize', 16)
                
                # Get position
                position = element.get('position') or template_element.get('position', {})
                x = position.get('x', 10)
                y = position.get('y', 10)
                
                # Get color
                color = element.get('color') or template_element.get('color', '#000000')
                
                # Get text alignment
                text_align = position.get('textAlign', 'left')
                vert_align = position.get('verticalAlign', 'baseline')
                
                # Load font
                font_path = self._get_font_path(font_family)
                if not font_path or not os.path.exists(font_path):
                    # 返回 None 和错误信息，而不是打印
                    return None, f"Font not found: {font_family}"
                
                font = ImageFont.truetype(font_path, size=font_size)
                
                # 计算文本宽度和高度并应用对齐
                try:
                    # 首先尝试使用旧方法
                    if hasattr(draw, 'textsize'):
                        text_width, text_height = draw.textsize(text, font=font)
                    # 然后尝试使用font.getsize (较旧版本Pillow)
                    elif hasattr(font, 'getsize'):
                        text_width, text_height = font.getsize(text)
                    # 最后尝试使用新版本的方法 (Pillow >= 9.0.0)
                    else:
                        left, top, right, bottom = font.getbbox(text)
                        text_width = right - left
                        text_height = bottom - top
                except Exception as e:
                    sys.stderr.write(f"Warning: Error calculating text size: {e}, using estimation\n")
                    # 如果所有方法都失败，使用估算
                    text_width = len(text) * font_size * 0.6
                    text_height = font_size
                
                # 计算放置位置
                place_x = x
                place_y = y
                
                # 水平对齐
                if text_align == 'center':
                    place_x = x - (text_width / 2)
                    # 调试输出
                    sys.stderr.write(f"Center alignment - adjusting x from {x} to {place_x} (width: {text_width})\n")
                elif text_align == 'right':
                    place_x = x - text_width
                    # 调试输出
                    sys.stderr.write(f"Right alignment - adjusting x from {x} to {place_x} (width: {text_width})\n")
                    
                # 垂直对齐
                if vert_align == 'top':
                    place_y = y + text_height * 0.1  # 向下调整使顶部对齐
                    # 调试输出
                    sys.stderr.write(f"Top alignment - adjusting y from {y} to {place_y} (height: {text_height})\n")
                elif vert_align == 'middle':
                    place_y = y - (text_height * 0.4)  # 向上调整使中部对齐
                    # 调试输出
                    sys.stderr.write(f"Middle alignment - adjusting y from {y} to {place_y} (height: {text_height})\n")
                
                # 调试信息
                sys.stderr.write(f"Drawing text '{text}' at ({place_x}, {place_y}), size: {text_width}x{text_height}, align: {text_align}/{vert_align}\n")
                
                # 添加调试模式下的参考点标记
                if self.data.get('debug', False):
                    # 在原始位置绘制红点
                    draw.ellipse((x-2, y-2, x+2, y+2), fill='red')
                    # 在实际起始位置绘制蓝点
                    draw.ellipse((place_x-2, place_y-2, place_x+2, place_y+2), fill='blue')
                
                # Draw text with proper alignment
                draw.text((place_x, place_y), text, fill=color, font=font)
                
            except Exception as e:
                return None, f"Error drawing text element: {e}"
        
        # Convert to specified format
        output = BytesIO()
        if self.format == 'jpeg':
            # Convert to RGB for JPEG (no alpha channel)
            rgb_img = Image.new('RGB', img.size, (255, 255, 255))
            rgb_img.paste(img, mask=img.split()[3])  # Use alpha as mask
            rgb_img.save(output, format='JPEG', quality=90)
        else:
            # Default to PNG
            img.save(output, format='PNG')
        
        return output.getvalue(), None
    
    def _generate_svg(self):
        """Generate an SVG with text either as text elements or converted to paths"""
        # Create SVG drawing
        dwg = Drawing(size=(self.width, self.height))
        
        # 确保设置正确的viewBox
        dwg.attribs['viewBox'] = f"0 0 {self.width} {self.height}"
        dwg.attribs['width'] = f"{self.width}px"
        dwg.attribs['height'] = f"{self.height}px"
        dwg.attribs['preserveAspectRatio'] = "xMidYMid meet"
        
        # Add white background
        dwg.add(Rect(insert=(0, 0), size=(self.width, self.height), fill='white'))
        
        # Add background image if specified
        if self.background_image_path:
            full_bg_path = os.path.join(os.getcwd(), self.background_image_path)
            if os.path.exists(full_bg_path):
                # For SVG background with text-to-path conversion
                if self.convert_text_to_paths and full_bg_path.lower().endswith('.svg'):
                    # Include SVG directly (ideally would parse and include elements)
                    try:
                        with open(full_bg_path, 'r') as bg_file:
                            bg_svg = bg_file.read()
                            # Extract SVG content without the header
                            import re
                            content = re.search(r'<svg[^>]*>(.*?)</svg>', bg_svg, re.DOTALL)
                            if content:
                                bg_group = dwg.g(id="background")
                                # 提取实际内容
                                content_str = content.group(1)
                                # 将背景SVG内容添加为外部SVG (注意：这并不是完全解析SVG的正确方法，但对简单情况可行)
                                bg_group.add(dwg.foreignObject(
                                    size=(self.width, self.height),
                                    content=f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}">{content_str}</svg>'
                                ))
                                # Add a comment to indicate the background source
                                bg_group.add(dwg.desc(f"Background from {self.background_image_path}"))
                                dwg.add(bg_group)
                    except Exception as e:
                        return None, f"Error processing SVG background: {e}"
                else:
                    # For raster backgrounds, embed as image
                    try:
                        # Encode image to base64
                        with open(full_bg_path, 'rb') as img_file:
                            img_data = base64.b64encode(img_file.read()).decode('utf-8')
                        
                        # Determine MIME type
                        mime_type = 'image/png'  # Default
                        if full_bg_path.lower().endswith('.jpg') or full_bg_path.lower().endswith('.jpeg'):
                            mime_type = 'image/jpeg'
                        
                        # Add image to SVG
                        dwg.add(dwg.image(
                            href=f"data:{mime_type};base64,{img_data}",
                            insert=(0, 0),
                            size=(self.width, self.height)
                        ))
                    except Exception as e:
                        return None, f"Error embedding background image: {e}"
        
        # Draw text elements
        for element in self.text_elements:
            try:
                # Get element properties
                text = element.get('value', '')
                if not text:
                    continue
                
                # Get font properties from template element if available
                template_element = next((t for t in self.template.get('textElements', []) 
                                       if t.get('id') == element.get('id')), {})
                
                font_family = element.get('fontFamily') or template_element.get('fontFamily', 'Arial')
                font_size = element.get('fontSize') or template_element.get('fontSize', 16)
                
                # Get position
                position = element.get('position') or template_element.get('position', {})
                x = position.get('x', 10)
                y = position.get('y', 10)
                
                # Get color
                color = element.get('color') or template_element.get('color', '#000000')
                
                # Get rotation
                rotation = position.get('rotation', 0)
                
                # Get text alignment
                text_align = position.get('textAlign', 'left')
                vert_align = position.get('verticalAlign', 'baseline')
                
                if self.convert_text_to_paths:
                    # 使用新方法：先创建文本路径，再定位
                    text_element = self._create_text_path_element(text, font_family, font_size, color)
                    if text_element:
                        # 计算文本尺寸
                        text_bbox = text_element.get('bbox', {'width': 0, 'height': 0})
                        text_width = text_bbox.get('width', 0)
                        text_height = text_bbox.get('height', 0)
                        
                        # 计算放置位置
                        place_x = x
                        place_y = y
                        
                        # 水平对齐
                        if text_align == 'center':
                            place_x = x - (text_width / 2)
                            # 调试输出
                            sys.stderr.write(f"Center alignment - adjusting x from {x} to {place_x} (width: {text_width})\n")
                        elif text_align == 'right':
                            place_x = x - text_width
                            # 调试输出
                            sys.stderr.write(f"Right alignment - adjusting x from {x} to {place_x} (width: {text_width})\n")
                            
                        # 垂直对齐
                        if vert_align == 'top':
                            place_y = y + text_height * 0.1  # 向下调整使顶部对齐
                            # 调试输出
                            sys.stderr.write(f"Top alignment - adjusting y from {y} to {place_y} (height: {text_height})\n")
                        elif vert_align == 'middle':
                            place_y = y - (text_height * 0.4)  # 向上调整使中部对齐
                            # 调试输出
                            sys.stderr.write(f"Middle alignment - adjusting y from {y} to {place_y} (height: {text_height})\n")
                        
                        # 调试信息
                        sys.stderr.write(f"Placing text '{text}' at ({place_x}, {place_y}), size: {text_width}x{text_height}\n")
                        
                        # 创建文本组并添加路径元素
                        text_group = dwg.g(id=f"text_{element.get('id', 'unknown')}")
                        
                        # 添加调试点
                        if self.data.get('debug', False):
                            # 原始锚点
                            text_group.add(dwg.circle(center=(x, y), r=2, fill='red'))
                            # 实际位置
                            text_group.add(dwg.circle(center=(place_x, place_y), r=2, fill='blue'))
                            
                            # 显示边界框
                            text_group.add(dwg.rect(
                                insert=(place_x, place_y - text_height * 0.8), 
                                size=(text_width, text_height),
                                fill='none',
                                stroke='green',
                                stroke_width=0.5
                            ))
                        
                        # 从预生成的路径元素中获取SVG路径
                        path_elements = text_element.get('paths', [])
                        
                        # 添加所有路径
                        for path_item in path_elements:
                            path_data = path_item.get('path')
                            x_offset = path_item.get('x_offset', 0)
                            
                            path = dwg.path(d=path_data)
                            
                            # 获取缩放因子
                            scale_factor = font_size / 1000  # 标准字体单位
                            
                            # 应用正确的变换
                            # 首先缩放字形，然后位移到字形在文本中的相对位置，最后移动到文本的最终位置
                            transform = f"translate({place_x + x_offset * scale_factor}, {place_y}) scale({scale_factor}, -{scale_factor})"
                            
                            # 如果有旋转，添加旋转变换
                            if rotation:
                                # 对于旋转，我们需要围绕文本中心旋转，而不是每个字符
                                # 所以先平移到文本中心，旋转，再平移回来
                                center_x = place_x + text_width / 2
                                center_y = place_y
                                transform = f"translate({place_x + x_offset * scale_factor}, {place_y}) scale({scale_factor}, -{scale_factor}) rotate({rotation}, {(center_x - place_x) / scale_factor}, 0)"
                                # 调试输出
                                sys.stderr.write(f"Applying rotation {rotation} around center ({center_x}, {center_y})\n")
                            
                            path['transform'] = transform
                            path['fill'] = color  # 确保路径有正确的填充颜色
                            text_group.add(path)
                        
                        # 将文本组添加到绘图中
                        dwg.add(text_group)
                    else:
                        # 如果路径创建失败，回退到旧方法
                        error = self._add_text_as_path(dwg, text, font_family, font_size, x, y, color, rotation, text_align)
                        if error:
                            return None, error
                else:
                    # Add text as SVG text element
                    text_element = Text(text, insert=(x, y), fill=color, font_size=font_size, 
                                       font_family=font_family)
                    
                    # Apply rotation if specified
                    if rotation:
                        text_element['transform'] = f"rotate({rotation} {x} {y})"
                    
                    # Apply text alignment
                    if text_align == 'center':
                        text_element['text-anchor'] = 'middle'
                    elif text_align == 'right':
                        text_element['text-anchor'] = 'end'
                    
                    dwg.add(text_element)
                
            except Exception as e:
                return None, f"Error drawing text element: {e}"
        
        # Return SVG as string
        svg_string = dwg.tostring()
        
        # 调试输出基本信息
        sys.stderr.write(f"Generated SVG size: {len(svg_string)} bytes\n")
        sys.stderr.write(f"SVG dimensions: {self.width}x{self.height}\n")
        
        # 记录SVG的前100个字符，帮助调试
        preview = svg_string[:min(100, len(svg_string))]
        sys.stderr.write(f"SVG preview: {preview}...\n")
        
        return svg_string, None
    
    def _add_text_as_path(self, dwg, text, font_family, font_size, x, y, color, rotation, text_align):
        """Add text converted to SVG path"""
        try:
            # Get font file path
            font_path = self._get_font_path(font_family)
            if not font_path or not os.path.exists(font_path):
                return f"Font not found: {font_family}"
            
            # Load font using fontTools
            font = TTFont(font_path)
            
            # Get the glyph set
            glyph_set = font.getGlyphSet()
            
            # Get vertical alignment (if available in the position data)
            position = next((elem.get('position', {}) for elem in self.text_elements if elem.get('value') == text), {})
            vert_align = position.get('verticalAlign', 'baseline')
            
            # Create a group for the text
            text_group = dwg.g(fill=color)
            
            # Apply rotation if specified
            if rotation:
                text_group['transform'] = f"rotate({rotation} {x} {y})"
            
            # Calculate text width for alignment
            total_width = 0
            cmap = font['cmap'].getBestCmap()
            
            # 估算文本高度
            ascender = font['hhea'].ascender if 'hhea' in font else 0
            descender = font['hhea'].descender if 'hhea' in font else 0
            text_height = (ascender - descender) * font_size / font['head'].unitsPerEm
            
            for char in text:
                if ord(char) in cmap:
                    glyph_name = cmap[ord(char)]
                    glyph = glyph_set[glyph_name]
                    width = glyph.width * font_size / font['head'].unitsPerEm
                    total_width += width
            
            # 输出调试信息
            sys.stderr.write(f"SVG Path text: '{text}', width: {total_width}, height: {text_height}, alignment: {text_align}/{vert_align}, position: ({x}, {y})\n")
            
            # Calculate starting position based on horizontal alignment
            start_x = x
            if text_align == 'center':
                start_x = x - (total_width / 2)
                sys.stderr.write(f"Center alignment - adjusted x: {start_x}\n")
            elif text_align == 'right':
                start_x = x - total_width
                sys.stderr.write(f"Right alignment - adjusted x: {start_x}\n")
            
            # 调整垂直位置
            draw_y = y
            
            # 在SVG路径转换中，y坐标系是反向的
            if vert_align == 'top':
                # Y轴指定为文本上方，需要向下移动
                draw_y = y + text_height * 0.8  # 向下移动以使文本顶部对齐
                sys.stderr.write(f"Top alignment - adjusted y: {draw_y}\n")
            elif vert_align == 'middle':
                # Y轴指定为文本中部，需要调整
                draw_y = y + text_height * 0.4  # 向下移动文本高度的一部分
                sys.stderr.write(f"Middle alignment - adjusted y: {draw_y}\n")
            
            # 添加调试模式下的参考点标记
            if self.data.get('debug', False):
                # 在原始文本位置添加一个小圆点作为参考
                dwg.add(dwg.circle(center=(x, y), r=2, fill='red'))
                # 在实际起始位置添加一个小圆点
                dwg.add(dwg.circle(center=(start_x, draw_y), r=2, fill='blue'))
            
            # Process each character
            current_x = start_x
            for char in text:
                if ord(char) in cmap:
                    glyph_name = cmap[ord(char)]
                    glyph = glyph_set[glyph_name]
                    
                    # Create SVG path pen
                    path_pen = SVGPathPen(glyph_set)
                    
                    # Draw the glyph to the path
                    glyph.draw(path_pen)
                    
                    # Get path data
                    path_data = path_pen.getCommands()
                    
                    if path_data:
                        # 将字形位置信息添加到路径数据中，以便后续正确放置
                        paths.append({
                            'path': path_data,
                            'x_offset': current_x,
                            'width': glyph.width
                        })
                    
                    # 前进到下一个字符位置
                    width = glyph.width * font_size / font['head'].unitsPerEm
                    current_x += width
            
            # Add the text group to the drawing
            dwg.add(text_group)
            return None
            
        except Exception as e:
            return f"Error converting text to path: {e}"

    def _create_text_path_element(self, text, font_family, font_size, color):
        """创建文本的路径对象，返回一个包含路径数据的字典"""
        try:
            # 获取字体文件路径
            font_path = self._get_font_path(font_family)
            if not font_path or not os.path.exists(font_path):
                sys.stderr.write(f"Font not found: {font_family}\n")
                return None
                
            # 使用fontTools加载字体
            font = TTFont(font_path)
            
            # 获取字形集
            glyph_set = font.getGlyphSet()
            
            # 获取cmap表
            cmap = font['cmap'].getBestCmap()
            
            # 创建一个临时绘图来保存路径
            temp_dwg = Drawing(size=(1000, 1000))
            
            # 获取字体信息
            units_per_em = font['head'].unitsPerEm
            ascender = font['hhea'].ascender if 'hhea' in font else 0
            descender = font['hhea'].descender if 'hhea' in font else 0
            
            # 计算总宽度和最大高度
            total_width = 0
            paths = []
            
            # 第一轮：计算总宽度
            for char in text:
                if ord(char) in cmap:
                    glyph_name = cmap[ord(char)]
                    glyph = glyph_set[glyph_name]
                    width = glyph.width * font_size / units_per_em
                    total_width += width
            
            # 第二轮：创建路径元素
            current_x = 0
            for char in text:
                if ord(char) in cmap:
                    glyph_name = cmap[ord(char)]
                    glyph = glyph_set[glyph_name]
                    
                    # 创建SVG路径笔
                    path_pen = SVGPathPen(glyph_set)
                    
                    # 绘制字形到路径
                    glyph.draw(path_pen)
                    
                    # 获取路径数据
                    path_data = path_pen.getCommands()
                    
                    if path_data:
                        # 将字形位置信息添加到路径数据中，以便后续正确放置
                        paths.append({
                            'path': path_data,
                            'x_offset': current_x,
                            'width': glyph.width
                        })
                    
                    # 前进到下一个字符位置
                    width = glyph.width * font_size / units_per_em
                    current_x += width
            
            # 计算文本高度
            text_height = (ascender - descender) * font_size / units_per_em
            
            # 返回包含所有路径和边界框信息的字典
            return {
                'paths': paths,  # 现在paths是包含路径和位置信息的对象列表
                'bbox': {
                    'width': total_width,
                    'height': text_height
                },
                'color': color
            }
            
        except Exception as e:
            sys.stderr.write(f"Error creating text path: {e}\n")
            return None

    def _generate_svg_cairo(self):
        """使用PyCairo生成SVG文件"""
        try:
            # 创建一个临时文件用于SVG输出
            svg_output = BytesIO()
            
            # 创建一个SVG表面
            surface = cairo.SVGSurface(svg_output, self.width, self.height)
            ctx = cairo.Context(surface)
            
            # 设置白色背景
            ctx.set_source_rgb(1, 1, 1)  # 白色
            ctx.rectangle(0, 0, self.width, self.height)
            ctx.fill()
            
            # 添加背景图片(如果指定)
            if self.background_image_path:
                full_bg_path = os.path.join(os.getcwd(), self.background_image_path)
                if os.path.exists(full_bg_path):
                    # 对于光栅图像背景
                    if full_bg_path.lower().endswith(('.png', '.jpg', '.jpeg')):
                        try:
                            img = Image.open(full_bg_path).convert('RGBA')
                            img = img.resize((self.width, self.height))
                            
                            # 转换为cairo可以使用的格式
                            img_data = BytesIO()
                            img.save(img_data, format='PNG')
                            img_data.seek(0)
                            
                            # 使用cairo加载图像
                            bg_surface = cairo.ImageSurface.create_from_png(img_data)
                            ctx.set_source_surface(bg_surface, 0, 0)
                            ctx.paint()
                        except Exception as e:
                            sys.stderr.write(f"Error loading background image with Cairo: {e}\n")
            
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
                    
                    # 尝试使用更准确的字体 - 获取字体文件路径
                    font_path = self._get_font_path(font_family)
                    if not font_path or not os.path.exists(font_path):
                        sys.stderr.write(f"Font file not found for Cairo: {font_family}, using system font\n")
                        # 使用系统字体
                        ctx.select_font_face(font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                    else:
                        # 记录找到的字体文件
                        sys.stderr.write(f"Using font file for Cairo: {font_path}\n")
                        # Cairo不直接支持加载TTF文件，所以只能使用系统字体名称
                        # 一般情况下系统已安装的字体会被Cairo找到
                        ctx.select_font_face(font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                    
                    ctx.set_font_size(font_size)
                    
                    # 获取文本尺寸
                    text_extents = ctx.text_extents(text)
                    text_width = text_extents.width
                    text_height = text_extents.height
                    
                    # 获取放置位置
                    place_x = x
                    place_y = y
                    
                    # 水平对齐
                    if text_align == 'center':
                        place_x = x - (text_width / 2)
                        sys.stderr.write(f"Cairo: Center alignment - x from {x} to {place_x}\n")
                    elif text_align == 'right':
                        place_x = x - text_width
                        sys.stderr.write(f"Cairo: Right alignment - x from {x} to {place_x}\n")
                    
                    # 垂直对齐 - Cairo默认使用基线对齐
                    # Cairo的y坐标从顶部开始，向下为正
                    if vert_align == 'top':
                        place_y = y + text_extents.height
                        sys.stderr.write(f"Cairo: Top alignment - y from {y} to {place_y}\n")
                    elif vert_align == 'middle':
                        place_y = y + (text_extents.height / 2)
                        sys.stderr.write(f"Cairo: Middle alignment - y from {y} to {place_y}\n")
                    
                    # 应用旋转
                    if rotation:
                        # 保存当前状态
                        ctx.save()
                        # 移动到旋转中心
                        ctx.translate(x, y)
                        # 旋转
                        ctx.rotate(rotation * (3.14159 / 180.0))  # 转换为弧度
                        # 移回去，但考虑到对齐
                        ctx.translate(-x, -y)
                    
                    # 设置颜色
                    ctx.set_source_rgb(color[0], color[1], color[2])
                    
                    # 移动到文本位置
                    ctx.move_to(place_x, place_y)
                    
                    # 绘制路径并填充
                    ctx.text_path(text)
                    ctx.fill()  # 填充路径
                    
                    # 恢复旋转前的状态
                    if rotation:
                        ctx.restore()
                    
                except Exception as e:
                    sys.stderr.write(f"Error drawing text with Cairo: {e}\n")
            
            # 完成SVG表面
            surface.finish()
            
            # 获取SVG内容
            svg_content = svg_output.getvalue().decode('utf-8')
            
            # 调试输出
            sys.stderr.write(f"Generated Cairo SVG size: {len(svg_content)} bytes\n")
            
            return svg_content, None
            
        except Exception as e:
            return None, f"Error generating SVG with Cairo: {e}"

    def generate(self):
        """Generate the stamp in the specified format"""
        if self.format == 'svg':
            # 优先使用Cairo生成SVG
            try:
                data, error = self._generate_svg_cairo()
                if error:
                    # 如果Cairo失败，回退到原始方法
                    sys.stderr.write(f"Cairo SVG generation failed: {error}, falling back to svgwrite\n")
                    data, error = self._generate_svg()
            except Exception as e:
                # 如果出现异常，回退到原始方法
                sys.stderr.write(f"Error in Cairo SVG generation: {e}, falling back to svgwrite\n")
                data, error = self._generate_svg()
        else:
            data, error = self._rasterize()
            
        if error:
            return None, error
        return data, None

    def save_to_file(self, filename=None):
        """Save the generated stamp to a file"""
        if not filename:
            # Generate a unique filename
            timestamp = int(time.time())
            filename = f"stamp_{timestamp}.{self.format}"
        
        # Generate the stamp
        data, error = self.generate()
        if error:
            return None, error
        
        # Save to file
        output_path = os.path.join(self.output_dir, filename)
        try:
            # Use text mode for SVG, binary mode for other formats
            if self.format == 'svg':
                with open(output_path, 'w') as f:
                    f.write(data)
            else:
                with open(output_path, 'wb') as f:
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
                if generator.format == 'svg':
                    encoded_data = base64.b64encode(data.encode('utf-8')).decode('utf-8')
                else:
                    encoded_data = base64.b64encode(data).decode('utf-8')
                print(json.dumps({'success': True, 'data': encoded_data}))
                
    except Exception as e:
        # Return error as JSON
        print(json.dumps({'success': False, 'error': str(e)}))

if __name__ == "__main__":
    main() 