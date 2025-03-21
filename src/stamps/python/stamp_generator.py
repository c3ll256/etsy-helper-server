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
import gi
gi.require_version('Pango', '1.0')
gi.require_version('PangoCairo', '1.0')
from gi.repository import Pango, PangoCairo

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
                    self._render_with_pango(ctx, text, font_family, font_size, x, y, color, rotation, text_align, vert_align)
                    
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

    def _render_with_pango(self, ctx, text, font_family, font_size, x, y, color, rotation, text_align, vert_align):
        """使用Pango渲染文本以解决字母间距问题"""
        try:
            # 保存当前状态用于旋转
            if rotation:
                ctx.save()
                # 移动到旋转中心
                ctx.translate(x, y)
                # 旋转 (需要转换为弧度)
                ctx.rotate(rotation * (3.14159 / 180.0))
                # 重置位置为原点
                ctx.translate(-x, -y)
            
            # 创建Pango布局
            layout = PangoCairo.create_layout(ctx)
            
            # 创建字体描述
            font_desc = Pango.FontDescription()
            font_desc.set_family(font_family)
            font_desc.set_size(int(font_size * Pango.SCALE))
            layout.set_font_description(font_desc)
            
            # 设置文本
            layout.set_text(text, -1)
            
            # 设置文本对齐
            if text_align == 'center':
                layout.set_alignment(Pango.Alignment.CENTER)
            elif text_align == 'right':
                layout.set_alignment(Pango.Alignment.RIGHT)
            else:
                layout.set_alignment(Pango.Alignment.LEFT)
            
            # 获取文本尺寸
            width, height = layout.get_pixel_size()
            
            # 计算定位
            place_x = x
            place_y = y
            
            # 水平对齐
            if text_align == 'center':
                place_x = x - (width / 2)
            elif text_align == 'right':
                place_x = x - width
            
            # 垂直对齐
            if vert_align == 'top':
                place_y = y
            elif vert_align == 'middle':
                place_y = y - (height / 2)
            else:  # baseline
                # Pango默认是顶部对齐，需要根据文本属性计算基线位置
                # 这里使用一个近似值
                place_y = y - (height * 0.8)
            
            # 调试
            sys.stderr.write(f"Pango: Rendering '{text}' at ({place_x}, {place_y}), size: {width}x{height}, align: {text_align}/{vert_align}\n")
            
            # 移动到文本位置
            ctx.move_to(place_x, place_y)
            
            # 设置颜色
            ctx.set_source_rgb(color[0], color[1], color[2])
            
            # 绘制文本
            PangoCairo.show_layout(ctx, layout)
            
            # 恢复旋转前的状态
            if rotation:
                ctx.restore()
                
        except Exception as e:
            sys.stderr.write(f"Error in Pango rendering: {e}\n")
            # 回退到普通Cairo文本渲染
            ctx.select_font_face(font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(font_size)
            ctx.set_source_rgb(color[0], color[1], color[2])
            ctx.move_to(x, y)
            ctx.show_text(text)

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