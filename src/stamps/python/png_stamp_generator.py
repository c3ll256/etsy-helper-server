#!/usr/bin/env python3
import sys
import json
import os
import base64
import time
import logging
from io import BytesIO
import math
import cairo
import uharfbuzz as hb
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(levelname)s: %(message)s'
)
logger = logging.getLogger('png_stamp_generator')

class PNGStampGenerator:
    def __init__(self, data):
        self.data = data
        self.template = data.get('template', {})
        self.text_elements = data.get('textElements', [])
        
        # 获取模板尺寸
        width = self.template.get('width', 500)
        height = self.template.get('height', 500)
        
        # 自动提升分辨率到1000px左右（如果尺寸太小）
        self.original_width = width
        self.original_height = height
        self.scale_factor = 1.0
        
        # 目标分辨率为1000px（取宽高的最大值计算）
        target_resolution = 1000
        max_dimension = max(width, height)
        
        # 仅当尺寸小于目标分辨率时进行缩放
        if max_dimension < target_resolution:
            self.scale_factor = target_resolution / max_dimension
            # 保持宽高比例放大
            self.width = int(width * self.scale_factor)
            self.height = int(height * self.scale_factor)
        else:
            self.width = width
            self.height = height
        
        self.background_image_path = self.template.get('backgroundImagePath', None)
        
        # Prepare output directory
        self.output_dir = os.path.join(os.getcwd(), 'uploads', 'stamps')
        os.makedirs(self.output_dir, exist_ok=True)
        
        # Map font families to font files
        self.font_map = self._build_font_map()
        
        # Initialize uharfbuzz cache
        self.hb_fonts = {}
        
        # Initialize PIL fonts cache
        self.pil_fonts = {}

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
                        
                        # Special handling for Montserrat font family
                        if font_family.startswith('Montserrat-'):
                            # Register all Montserrat variants as Montserrat font
                            font_map['Montserrat'] = font_path
        
        # Simplified log output
        logger.debug(f"Available fonts: {list(font_map.keys())}")
        
        return font_map

    def _get_font_path(self, font_family):
        """Get the font file path for a given font family"""
        if font_family in self.font_map:
            return self.font_map[font_family]
            
        # Try case-insensitive matching
        for name in self.font_map:
            if name.lower() == font_family.lower():
                return self.font_map[name]
                    
        logger.warning(f"Font not found: {font_family}")
        return self.font_map.get('Arial')  # Default fallback

    def _get_pil_font(self, font_family, font_size):
        """Get a PIL ImageFont object for the specified font family and size"""
        key = (font_family, font_size)
        if key in self.pil_fonts:
            return self.pil_fonts[key]
        
        try:
            font_path = self._get_font_path(font_family)
            font = ImageFont.truetype(font_path, int(font_size))
            self.pil_fonts[key] = font
            return font
        except Exception as e:
            logger.error(f"Error loading font {font_family}: {e}")
            # Fallback to default font
            try:
                default_font_path = self._get_font_path('Arial')
                font = ImageFont.truetype(default_font_path, int(font_size))
                self.pil_fonts[key] = font
                return font
            except:
                # Last resort fallback
                return ImageFont.load_default()

    def _hex_to_rgb(self, hex_color):
        """Convert hex color string to RGB tuple"""
        hex_color = hex_color.lstrip('#')
        return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))

    def _create_transparent_image(self):
        """Create a transparent RGBA image"""
        return Image.new('RGBA', (self.width, self.height), (0, 0, 0, 0))

    def _draw_text_with_pil(self, img, text, font_family, font_size, x, y, color, rotation, text_align, vert_align):
        """Draw text on the image using PIL"""
        try:
            draw = ImageDraw.Draw(img)
            
            # 根据缩放比例调整字体大小
            scaled_font_size = int(font_size * self.scale_factor)
            font = self._get_pil_font(font_family, scaled_font_size)
            
            # Get position attributes
            circular_text = False
            radius = 0
            start_angle = 0
            end_angle = 360
            direction = 'clockwise'
            baseline_position = 'inside'  # New parameter, default to inside
            
            # Find current text element attributes
            for element in self.text_elements:
                if element.get('value') == text:
                    position = element.get('position', {})
                    circular_text = position.get('isCircular', False)
                    if circular_text:
                        # 根据缩放比例调整半径
                        radius = position.get('radius', 200) * self.scale_factor
                        start_angle = position.get('startAngle', 0)
                        end_angle = position.get('endAngle', 360)
                        direction = position.get('direction', 'clockwise')
                        baseline_position = position.get('baselinePosition', 'inside')
                    break
            
            # Convert color from hex to RGB
            rgb_color = self._hex_to_rgb(color) if isinstance(color, str) else color
            
            # 根据缩放比例调整坐标位置
            scaled_x = x * self.scale_factor
            scaled_y = y * self.scale_factor
            
            if circular_text:
                # Handle circular text rendering with scaled parameters
                self._draw_circular_text(img, text, font, scaled_font_size, scaled_x, scaled_y, rgb_color, radius, 
                                       start_angle, baseline_position, position)
            else:
                # Handle regular text rendering
                bbox = font.getbbox(text)
                text_width, text_height = bbox[2] - bbox[0], bbox[3] - bbox[1]
                
                # 检查文本是否超出可用宽度，并考虑缩放后的图像大小
                padding = int(50 * self.scale_factor)  # 缩放padding以匹配图像大小
                max_available_width = self.width - padding
                if rotation % 180 != 0:
                    if rotation % 180 > 45 and rotation % 180 < 135:
                        max_available_width = self.height - padding
                
                # Scale down text if needed
                text_scale_factor = 1.0
                if text_width > max_available_width:
                    text_scale_factor = max_available_width / text_width
                    adjusted_font_size = int(scaled_font_size * text_scale_factor)
                    font = self._get_pil_font(font_family, adjusted_font_size)
                    # Recalculate text dimensions
                    bbox = font.getbbox(text)
                    text_width, text_height = bbox[2] - bbox[0], bbox[3] - bbox[1]
                
                # Calculate position based on alignment
                place_x = scaled_x
                if text_align == 'center':
                    place_x = scaled_x - (text_width / 2)
                elif text_align == 'right':
                    place_x = scaled_x - text_width
                
                place_y = scaled_y
                ascent, descent = font.getmetrics()
                if vert_align == 'top':
                    place_y = scaled_y
                elif vert_align == 'middle':
                    place_y = scaled_y - text_height / 2
                else:  # baseline
                    place_y = scaled_y - ascent
                
                # Create a new image for the rotated text
                if rotation != 0:
                    # 使用自适应的填充以确保文本不被切割
                    # 增加填充系数以处理极端情况
                    padding_ratio = 0.7  # 增加填充比例从0.5到0.7
                    base_padding = int(30 * self.scale_factor)  # 增加基础填充
                    
                    # 对于大字体和长文本使用更大的填充
                    text_length_factor = min(len(text) / 5, 2.0)  # 文本越长，填充越大，最多2倍
                    font_size_factor = min(scaled_font_size / 30, 3.0)  # 字体越大，填充越大，最多3倍
                    
                    # 综合考虑文本长度和字体大小计算自适应填充
                    adaptive_padding = max(
                        base_padding, 
                        int(scaled_font_size * padding_ratio * text_length_factor * font_size_factor)
                    )
                    
                    # 创建足够大的文本图像
                    txt_img = Image.new('RGBA', (text_width + 2*adaptive_padding, text_height + 2*adaptive_padding), (0, 0, 0, 0))
                    txt_draw = ImageDraw.Draw(txt_img)
                    
                    # 在文本图像中心绘制文本
                    txt_draw.text((adaptive_padding, adaptive_padding), text, font=font, fill=rgb_color)
                    
                    # 添加调试边框来确认文本边界（可选，最终可删除）
                    # txt_draw.rectangle([0, 0, txt_img.width-1, txt_img.height-1], outline=(255, 0, 0, 128))
                    
                    # 旋转文本图像
                    rotated_txt = txt_img.rotate(-rotation, expand=True, resample=Image.BICUBIC)
                    
                    # 计算粘贴位置
                    paste_x = int(place_x) - adaptive_padding
                    paste_y = int(place_y) - adaptive_padding
                    
                    # 粘贴旋转后的文本到主图像
                    img.paste(rotated_txt, (paste_x, paste_y), rotated_txt)
                else:
                    # 为非旋转文本添加基于字体大小的垂直偏移
                    # 增加垂直偏移比例以避免底部切割
                    vertical_offset = max(4, int(scaled_font_size * 0.08))  # 增加从0.05到0.08
                    place_y -= vertical_offset
                    
                    # 增加额外的垂直空间，特别是对于大字体
                    if scaled_font_size > 60:
                        place_y -= int(scaled_font_size * 0.05)  # 大字体额外偏移
                    
                    draw.text((place_x, place_y), text, font=font, fill=rgb_color)
                
        except Exception as e:
            logger.error(f"Error drawing text with PIL: {e}")
            # Fallback to simple text rendering
            try:
                draw = ImageDraw.Draw(img)
                default_font = self._get_pil_font('Arial', scaled_font_size)
                draw.text((scaled_x, scaled_y), text, font=default_font, fill=rgb_color)
            except Exception as fallback_error:
                logger.error(f"Fallback text rendering failed: {fallback_error}")

    def _draw_circular_text(self, img, text, font, font_size, center_x, center_y, color, radius, 
                          start_angle, baseline_position, position):
        """Draw text in a circular path"""
        try:
            draw = ImageDraw.Draw(img)
            layout_mode = position.get('layoutMode', 'startAligned')
            base_angle = position.get('baseAngle', 0)
            letter_spacing = position.get('letterSpacing', 1.0)
            
            # Adjust text sequence based on baseline position
            reverse_text = baseline_position == 'outside'
            text_to_render = text[::-1] if reverse_text else text
            
            # Calculate text metrics for spacing
            total_width = 0
            char_widths = []
            char_heights = []
            for char in text_to_render:
                bbox = font.getbbox(char)
                width = bbox[2] - bbox[0]
                height = bbox[3] - bbox[1]
                char_widths.append(width)
                char_heights.append(height)
                total_width += width
            
            # 计算最大字符高度，用于设置足够的内外边距
            max_char_height = max(char_heights) if char_heights else 0
            
            # Calculate text arc ratio and spacing
            circumference = 2 * math.pi * radius
            text_arc_ratio = total_width / circumference
            
            # Apply spacing adjustments
            base_spacing = 1.0
            spacing_factor = base_spacing * letter_spacing
            
            # Fine-tune spacing for different text lengths
            if text_arc_ratio < 0.1:
                spacing_factor *= 1.1
            elif text_arc_ratio > 0.5:
                spacing_factor *= 0.95
            
            # Font-specific adjustments
            font_family_lower = font.path.lower()
            if 'montserrat' in font_family_lower or 'arial' in font_family_lower or 'helvetica' in font_family_lower:
                spacing_factor *= 1.05
            
            # Calculate total angle
            total_angle_rad = (total_width / radius) * spacing_factor
            total_angle_deg = total_angle_rad * (180 / math.pi)
            
            # Determine starting angle based on layout mode
            if layout_mode == 'centerAligned':
                start_angle = (base_angle - total_angle_deg/2) % 360
            else:
                start_angle = base_angle
            
            # Current position tracking
            current_angle = start_angle
            current_width = 0
            
            # Calculate position for each character
            char_positions = []
            for i, (char, width) in enumerate(zip(text_to_render, char_widths)):
                char_angle_deg = (width / radius) * spacing_factor * (180 / math.pi)
                center_angle_deg = current_angle + char_angle_deg / 2
                char_positions.append({
                    'char': char,
                    'width': width,
                    'center_angle_deg': center_angle_deg,
                    'angle_deg': char_angle_deg
                })
                current_angle += char_angle_deg
                current_width += width
            
            # Adjust positions for more even distribution if needed
            total_actual_angle = current_angle - start_angle
            if total_actual_angle > 10:
                adjustment_ratio = total_angle_deg / total_actual_angle
                current_angle = start_angle
                for pos in char_positions:
                    pos['angle_deg'] *= adjustment_ratio
                    pos['center_angle_deg'] = current_angle + pos['angle_deg']/2
                    current_angle += pos['angle_deg']
            
            # Draw each character
            for pos in char_positions:
                char = pos['char']
                center_angle_deg = pos['center_angle_deg']
                center_angle_rad = center_angle_deg * (math.pi / 180.0)
                
                # Calculate position on the circle
                char_x = center_x + radius * math.cos(center_angle_rad)
                char_y = center_y + radius * math.sin(center_angle_rad)
                
                # Calculate rotation angle
                rotation_angle = center_angle_rad + (math.pi / 2)
                if baseline_position == 'outside':
                    rotation_angle += math.pi
                
                rotation_deg = rotation_angle * (180 / math.pi)
                
                # Create a small image for this character with adaptive padding
                bbox = font.getbbox(char)
                char_width, char_height = bbox[2] - bbox[0], bbox[3] - bbox[1]
                
                # 使用更大的填充来处理圆形文本
                padding_ratio = 0.6  # 增加填充比例从0.4到0.6
                base_padding = int(20 * self.scale_factor)  # 增加并缩放基础填充
                
                # 根据字体大小和字符大小计算更合适的填充
                # 对于尤其大的字体，使用更大的填充
                font_size_factor = min(font_size / 30, 3.0)  # 字体越大，填充越大，最多3倍
                adaptive_padding = max(
                    base_padding, 
                    int(font_size * padding_ratio * font_size_factor)
                )
                
                # 确保每个字符有足够的空间，尤其是对于特殊字符
                char_img = Image.new('RGBA', (char_width + 2*adaptive_padding, char_height + 2*adaptive_padding), (0, 0, 0, 0))
                char_draw = ImageDraw.Draw(char_img)
                
                # 在字符图像中心绘制字符
                char_draw.text((adaptive_padding, adaptive_padding), char, font=font, fill=color)
                
                # 旋转字符
                rotated_char = char_img.rotate(-rotation_deg, expand=True, resample=Image.BICUBIC)
                
                # 计算粘贴位置
                paste_x = int(char_x - rotated_char.width / 2)
                paste_y = int(char_y - rotated_char.height / 2)
                
                # 粘贴到主图像
                img.paste(rotated_char, (paste_x, paste_y), rotated_char)
                
        except Exception as e:
            logger.error(f"Error drawing circular text: {e}")

    def generate(self):
        """Generate the stamp in PNG format"""
        try:
            # Create a transparent base image
            img = self._create_transparent_image()
            
            # Load background image if specified
            if self.background_image_path:
                try:
                    bg_path = os.path.join(os.getcwd(), self.background_image_path)
                    if os.path.exists(bg_path):
                        bg_img = Image.open(bg_path).convert('RGBA')
                        
                        # Calculate scaling to fit the target dimensions while preserving aspect ratio
                        bg_width, bg_height = bg_img.size
                        scale_x = self.width / bg_width
                        scale_y = self.height / bg_height
                        scale = min(scale_x, scale_y)  # Changed from max to min to preserve aspect ratio
                        
                        # Calculate new dimensions
                        new_width = int(bg_width * scale)
                        new_height = int(bg_height * scale)
                        
                        # Resize background while preserving aspect ratio
                        bg_img = bg_img.resize((new_width, new_height), Image.LANCZOS)
                        
                        # Calculate position for centering
                        x_offset = (self.width - new_width) // 2
                        y_offset = (self.height - new_height) // 2
                        
                        # Create a new image with the background
                        new_img = self._create_transparent_image()
                        new_img.paste(bg_img, (x_offset, y_offset), bg_img)
                        img = new_img
                except Exception as e:
                    logger.error(f"Error loading background image: {e}")
            
            # Draw text elements
            for element in self.text_elements:
                try:
                    # Get element attributes
                    text = element.get('value', '')
                    if not text:
                        continue
                    
                    # Get template element if available
                    template_element = next((t for t in self.template.get('textElements', []) 
                                           if t.get('id') == element.get('id')), {})
                    
                    font_family = element.get('fontFamily') or template_element.get('fontFamily', 'Arial')
                    font_size = element.get('fontSize') or template_element.get('fontSize', 16)
                    
                    # Get position
                    position = element.get('position') or template_element.get('position', {})
                    x = position.get('x', 10)
                    y = position.get('y', 10)
                    
                    # Get color
                    color_str = element.get('color') or template_element.get('color', '#000000')
                    
                    # Get rotation
                    rotation = position.get('rotation', 0)
                    
                    # Get text alignment
                    text_align = position.get('textAlign', 'left')
                    vert_align = position.get('verticalAlign', 'baseline')
                    
                    # Draw the text
                    self._draw_text_with_pil(img, text, font_family, font_size, x, y, color_str, rotation, text_align, vert_align)
                    
                except Exception as e:
                    logger.error(f"Error drawing text element: {e}")
            
            # 如果应用了缩放，考虑添加锐化处理以提高图像质量
            if self.scale_factor > 1.0:
                img = img.filter(ImageFilter.SHARPEN)
            
            # Convert to PNG
            output = BytesIO()
            img.save(output, format='PNG')
            data = output.getvalue()
            
            return data, None
            
        except Exception as e:
            error_msg = f"Error generating PNG: {e}"
            logger.error(error_msg)
            return None, error_msg

    def save_to_file(self, filename=None):
        """Save the generated stamp to a file"""
        if not filename:
            # Generate a unique filename
            timestamp = int(time.time())
            filename = f"stamp_{timestamp}.png"
        elif not filename.lower().endswith('.png'):
            filename += '.png'
        
        # Generate the stamp
        data, error = self.generate()
        if error:
            return None, error
        
        # Save to file
        output_path = os.path.join(self.output_dir, filename)
        try:
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
        generator = PNGStampGenerator(input_data)
        
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
                encoded_data = base64.b64encode(data).decode('utf-8')
                print(json.dumps({'success': True, 'data': encoded_data}))
                
    except Exception as e:
        # Return error as JSON
        print(json.dumps({'success': False, 'error': str(e)}))

if __name__ == "__main__":
    main() 