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
from PIL import Image
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
import cairo
import math
import uharfbuzz as hb

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
                    
        sys.stderr.write(f"Font not found: {font_family}. Available fonts: {list(self.font_map.keys())}\n")
        return self.font_map.get('Arial')  # Default fallback

    def _generate_svg_cairo(self):
        """使用PyCairo和Pango生成SVG文件"""
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
                    # 只处理SVG背景图片
                    if full_bg_path.lower().endswith('.svg'):
                        try:
                            # 读取SVG内容
                            with open(full_bg_path, 'r') as f:
                                svg_content = f.read()
                            
                            # 创建临时SVG表面
                            temp_surface = cairo.SVGSurface(None, self.width, self.height)
                            temp_ctx = cairo.Context(temp_surface)
                            
                            # 使用librsvg或直接导入SVG (如果可用)
                            try:
                                import rsvg
                                handle = rsvg.Handle(file=full_bg_path)
                                handle.render_cairo(temp_ctx)
                            except ImportError:
                                # 如果librsvg不可用，尝试直接嵌入SVG内容
                                # 注意：这种方法只在Cairo 1.15.10+版本有效
                                try:
                                    # 将SVG嵌入到当前SVG中
                                    ctx.save()
                                    # 尝试缩放到适合尺寸
                                    ctx.scale(self.width / 100, self.height / 100)  # 假设原SVG为100x100单位
                                    ctx.push_group()
                                    PangoCairo.error_underline_path(ctx)  # 触发渲染
                                    ctx.pop_group_to_source()
                                    ctx.paint()
                                    ctx.restore()
                                    
                                    sys.stderr.write(f"Embedded SVG background directly\n")
                                except Exception as inner_e:
                                    sys.stderr.write(f"Error embedding SVG directly: {inner_e}, adding as link\n")
                                    # 如果直接嵌入失败，添加引用
                                    # 注意: 这个功能需要Cairo SVG后端支持，并不是所有版本都支持
                                    relative_path = os.path.relpath(full_bg_path, os.getcwd())
                                    # 在输出中写入引用信息
                                    sys.stderr.write(f"Added SVG reference to: {relative_path}\n")
                        except Exception as e:
                            sys.stderr.write(f"Error processing SVG background: {e}\n")
                    else:
                        sys.stderr.write(f"Only SVG backgrounds are supported. Ignoring: {full_bg_path}\n")
            
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

    def _render_with_advanced_cairo(self, ctx, text, font_family, font_size, x, y, color, rotation, text_align, vert_align):
        """使用uharfbuzz处理字体间距并使用Cairo渲染文本"""
        try:
            # 保存当前状态用于旋转
            ctx.save()
            
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
                
                # 调试输出
                sys.stderr.write(f"uharfbuzz rendering '{text}' at ({place_x}, {place_y}), total width: {total_width}\n")
                
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
                sys.stderr.write(f"Error with uharfbuzz: {hb_error}, falling back to basic rendering\n")
                # 回退到基本的渲染
                ctx.select_font_face(font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                ctx.set_font_size(font_size)
                
                # 获取文本尺寸
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
            sys.stderr.write(f"Error in advanced Cairo rendering: {e}\n")
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
            sys.stderr.write(f"Error in Cairo SVG generation: {error}\n")
            return None, error
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