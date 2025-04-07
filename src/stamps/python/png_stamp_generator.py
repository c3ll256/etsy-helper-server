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
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

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
        
        # Initialize font cache
        self.font_cache = {}
        
        # Initialize variable font information cache
        self.variable_font_info = {}
        
        # Track font size adjustments
        self.font_size_adjustments = {}

    def _build_font_map(self):
        """Build a mapping of font family names to font file paths and metadata"""
        font_map = {}
        
        # Check if we received font mapping from NestJS
        nodejs_font_mapping = self.data.get('fontMapping', {})
        if nodejs_font_mapping:            
            # Convert NestJS font mapping to our internal format
            for font_name, font_path in nodejs_font_mapping.items():
                if os.path.exists(font_path):
                    # Check if it's a variable font and extract axes information
                    is_variable, axes_info = self._analyze_font(font_path)
                    
                    font_map[font_name] = {
                        'path': font_path,
                        'isVariableFont': is_variable,
                        'variableAxes': axes_info
                    }
                else:
                    logger.warning(f"Font path from NestJS does not exist: {font_path}")
        
        # Default font as fallback
        default_fonts = [
            '/System/Library/Fonts/Arial.ttf',  # macOS
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',  # Linux
            'C:\\Windows\\Fonts\\arial.ttf'  # Windows
        ]
        
        # Find a working default font
        for font_path in default_fonts:
            if os.path.exists(font_path):
                font_map['Arial'] = {
                    'path': font_path,
                    'isVariableFont': False,
                    'variableAxes': None
                }
                break
        
        # Scan the fonts directory for custom fonts only if we don't have a valid mapping from NestJS
        if not nodejs_font_mapping:
            fonts_dir = os.path.join(os.getcwd(), 'uploads', 'fonts')
            if os.path.exists(fonts_dir):
                for file in os.listdir(fonts_dir):
                    if file.lower().endswith(('.ttf', '.otf')):
                        font_path = os.path.join(fonts_dir, file)
                        font_family = os.path.splitext(file)[0]
                        
                        # Check if it's a variable font and extract axes information
                        is_variable, axes_info = self._analyze_font(font_path)
                        
                        font_map[font_family] = {
                            'path': font_path,
                            'isVariableFont': is_variable,
                            'variableAxes': axes_info
                        }
        
        # Simplified log output
        logger.debug(f"Available fonts: {list(font_map.keys())}")
        
        return font_map

    def _analyze_font(self, font_path):
        """Analyze font file to determine if it's a variable font and extract axes information"""
        try:
            # 检查文件是否存在
            if not os.path.exists(font_path):
                logger.error(f"Font file does not exist: {font_path}")
                return False, None

            # 加载字体
            try:
                font = TTFont(font_path, lazy=False)
            except Exception as e:
                try:
                    font = TTFont(font_path)
                except Exception as e:
                    logger.error(f"Error opening font: {e}")
                    return False, None
            
            # 检测是否为可变字体
            is_variable = False
            
            # 通过键或表检测可变字体
            if (hasattr(font, 'keys') and 'fvar' in font.keys()) or \
               (hasattr(font, 'tables') and 'fvar' in getattr(font, 'tables', {})):
                is_variable = True
            elif (hasattr(font, 'keys') and ('gvar' in font.keys() or 'cvar' in font.keys())) or \
                 (hasattr(font, 'tables') and ('gvar' in getattr(font, 'tables', {}) or 'cvar' in getattr(font, 'tables', {}))):
                is_variable = True
            
            # 检查OS/2表中的字重信息
            weight_class = None
            try:
                if 'OS/2' in getattr(font, 'tables', {}) or (hasattr(font, 'keys') and 'OS/2' in font.keys()):
                    os2_table = font['OS/2']
                    if hasattr(os2_table, 'usWeightClass'):
                        weight_class = os2_table.usWeightClass
            except Exception:
                pass
            
            # 提取轴信息
            axes_info = None
            if is_variable:
                try:
                    if 'fvar' in getattr(font, 'tables', {}) or (hasattr(font, 'keys') and 'fvar' in font.keys()):
                        fvar_table = font['fvar']
                        axes_info = {}
                        
                        if hasattr(fvar_table, 'axes'):
                            for axis in fvar_table.axes:
                                axes_info[axis.axisTag] = {
                                    'min': float(axis.minValue),
                                    'max': float(axis.maxValue),
                                    'default': float(axis.defaultValue)
                                }
                except Exception:
                    # 设置默认轴信息
                    axes_info = {'wght': {'min': 100, 'max': 900, 'default': 400}}
            
            # 强制处理：对明显的可变字体
            font_name_lower = os.path.basename(font_path).lower()
            if not is_variable and ('variable' in font_name_lower or 'vf' in font_name_lower.split('.')[0].split('-')):
                is_variable = True
                if not axes_info:
                    axes_info = {'wght': {'min': 100, 'max': 900, 'default': 400}}
            
            return is_variable, axes_info
        except Exception as e:
            logger.error(f"Error analyzing font {font_path}: {e}")
            return False, None

    def _get_font_info(self, font_family):
        """Get font info for a given font family"""
        if not font_family:
            logger.warning("Empty font family provided, using default font")
            return self.font_map.get('Arial', next(iter(self.font_map.values())) if self.font_map else None)
            
        # Direct match
        if font_family in self.font_map:
            return self.font_map[font_family]
            
        # Try case-insensitive matching
        for name in self.font_map:
            if name.lower() == font_family.lower():
                return self.font_map[name]
        
        # Try to match font family regardless of weight/style suffix
        # E.g., if "Montserrat-Bold" is requested but only "Montserrat-Regular" exists
        if '-' in font_family:
            base_family = font_family.split('-')[0]
            if base_family in self.font_map:
                logger.debug(f"Using {base_family} as fallback for {font_family}")
                return self.font_map[base_family]
                
            # Try to find any font with the same base family
            for name in self.font_map:
                if name.startswith(f"{base_family}-"):
                    logger.debug(f"Using {name} as fallback for {font_family}")
                    return self.font_map[name]
        
        # If we get here, we couldn't find the font
        logger.warning(f"Font not found: {font_family}")
        # Return any available font as fallback
        default_font = self.font_map.get('Arial')
        if default_font:
            return default_font
            
        # Last resort: return the first available font
        if self.font_map:
            first_font = next(iter(self.font_map.values()))
            logger.warning(f"Using {next(iter(self.font_map.keys()))} as last resort fallback")
            return first_font
            
        # If there are no fonts at all, return None and let calling code handle it
        logger.error("No fonts available in font_map")
        return None

    def _get_pil_font(self, font_family, font_size, variable_settings=None):
        """
        Get a PIL ImageFont object for the specified font family and size
        
        Parameters:
            font_family (str): The font family name
            font_size (int): The font size in points
            variable_settings (dict, optional): Settings for variable font axes, e.g. {'wght': 700}
        """
        # 创建缓存键，包含字体名称、大小和变量设置
        cache_key = (font_family, font_size, str(variable_settings) if variable_settings else "default")
        
        if cache_key in self.font_cache:
            return self.font_cache[cache_key]
        
        try:
            # 获取字体信息
            font_info = self._get_font_info(font_family)
            if not font_info:
                logger.error(f"Could not get font info for {font_family}, no fonts available")
                # Use PIL's default font as a last resort
                default_font = ImageFont.load_default()
                self.font_cache[cache_key] = default_font
                return default_font
                
            font_path = font_info.get('path')
            if not font_path or not os.path.exists(font_path):
                logger.error(f"Font path does not exist: {font_path}")
                # Try system default font
                default_fonts = [
                    '/System/Library/Fonts/Arial.ttf',  # macOS
                    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',  # Linux
                    'C:\\Windows\\Fonts\\arial.ttf'  # Windows
                ]
                for default_path in default_fonts:
                    if os.path.exists(default_path):
                        font_path = default_path
                        logger.debug(f"Using system default font: {font_path}")
                        break
                if not font_path or not os.path.exists(font_path):
                    # Use PIL's default font as a last resort
                    default_font = ImageFont.load_default()
                    self.font_cache[cache_key] = default_font
                    return default_font
                
            is_variable = font_info.get('isVariableFont', False)
            
            if is_variable and variable_settings:
                # 处理可变字体设置
                temp_font_path = self._create_instance_of_variable_font(font_path, variable_settings)
                if temp_font_path:
                    font = ImageFont.truetype(temp_font_path, int(font_size))
                else:
                    # 如果无法创建实例，使用原始字体
                    font = ImageFont.truetype(font_path, int(font_size))
            else:
                # 使用常规字体
                font = ImageFont.truetype(font_path, int(font_size))
                
            self.font_cache[cache_key] = font
            return font
        except Exception as e:
            logger.error(f"Error loading font {font_family}: {e}")
            # Fallback to default font
            try:
                # Try to find a working system font
                default_fonts = [
                    '/System/Library/Fonts/Arial.ttf',  # macOS
                    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',  # Linux
                    'C:\\Windows\\Fonts\\arial.ttf'  # Windows
                ]
                for default_path in default_fonts:
                    if os.path.exists(default_path):
                        font = ImageFont.truetype(default_path, int(font_size))
                        self.font_cache[cache_key] = font
                        logger.debug(f"Using system fallback font: {default_path}")
                        return font
                
                # If no system fonts work, use PIL's default
                logger.warning("Using PIL's default font as last resort")
                default_font = ImageFont.load_default()
                self.font_cache[cache_key] = default_font
                return default_font
            except Exception as fallback_err:
                logger.error(f"Failed to load any fonts, even defaults: {fallback_err}")
                # Last resort fallback
                return ImageFont.load_default()

    def _create_instance_of_variable_font(self, font_path, axis_values):
        """
        创建变量字体的特定实例
        
        Parameters:
            font_path (str): 原始可变字体文件路径
            axis_values (dict): 轴值映射，e.g. {'wght': 700, 'wdth': 80}
            
        Returns:
            str: 临时字体实例的文件路径，如果失败则返回None
        """
        try:
            # 创建临时目录（如果不存在）
            temp_dir = os.path.join(os.getcwd(), 'uploads', 'temp_fonts')
            os.makedirs(temp_dir, exist_ok=True)
            
            # 计算唯一的输出文件名
            font_name = os.path.basename(font_path)
            basename, ext = os.path.splitext(font_name)
            instance_name = f"{basename}-{''.join(f'{tag}{val}' for tag, val in axis_values.items())}{ext}"
            output_path = os.path.join(temp_dir, instance_name)
            
            # 如果实例已经存在，直接返回
            if os.path.exists(output_path):
                return output_path
                
            # 使用fontTools创建指定实例
            font = TTFont(font_path)
            instance_font = instancer.instantiateVariableFont(font, axis_values)
            instance_font.save(output_path)
            
            return output_path
        except Exception as e:
            logger.error(f"Error creating variable font instance: {e}")
            return None

    def _hex_to_rgb(self, hex_color):
        """Convert hex color string to RGB tuple"""
        hex_color = hex_color.lstrip('#')
        return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))

    def _create_transparent_image(self):
        """Create a transparent RGBA image"""
        return Image.new('RGBA', (self.width, self.height), (0, 0, 0, 0))

    def _draw_text_with_pil(self, img, text, font_family, font_size, x, y, color, rotation, text_align, vert_align, original_text=None):
        """Draw text on the image using PIL"""
        try:
            draw = ImageDraw.Draw(img)
            
            # 根据缩放比例调整字体大小
            scaled_font_size = int(font_size * self.scale_factor)
            
            # 获取当前文本元素及其属性
            current_element = None
            variable_settings = None
            font_weight = None
            element_id = None
            
            # 使用原始文本或转换后的文本来查找元素
            lookup_text = original_text if original_text is not None else text
            
            for element in self.text_elements:
                if element.get('value') == lookup_text:
                    current_element = element
                    position = element.get('position', {})
                    element_id = element.get('id')
                    
                    # 保存字体权重信息，无论是否为可变字体都可能会用到
                    font_weight = element.get('fontWeight')
                    
                    # 检查是否有可变字体设置
                    if 'variableFontSettings' in element:
                        variable_settings = element.get('variableFontSettings')
                        logger.debug(f"Using explicit variableFontSettings: {variable_settings}")
                    break
            
            # 如果没有显式设置变量设置，则从fontWeight创建
            if not variable_settings and font_weight:
                # 转换fontWeight为wght值
                wght_value = 400  # 默认值
                
                # 字符串形式的权重处理
                if isinstance(font_weight, str):
                    if font_weight.lower() == 'bold':
                        wght_value = 700
                    elif font_weight.lower() == 'medium':
                        wght_value = 500
                    elif font_weight.lower() == 'semibold':
                        wght_value = 600
                    elif font_weight.lower() == 'light':
                        wght_value = 300
                    elif font_weight.lower() == 'thin' or font_weight.lower() == 'hairline':
                        wght_value = 100
                    elif font_weight.lower() == 'black':
                        wght_value = 900
                    elif font_weight.lower() == 'extrabold':
                        wght_value = 800
                    elif font_weight.lower() == 'extralight':
                        wght_value = 200
                    elif font_weight.isdigit():
                        wght_value = int(font_weight)
                # 数字形式的权重处理
                elif isinstance(font_weight, (int, float)):
                    wght_value = int(font_weight)
                
                # 创建变量字体设置
                variable_settings = {'wght': wght_value}
                logger.debug(f"Created variable font settings from fontWeight '{font_weight}': {variable_settings}")
            
            # 常规权重的显式变量字体设置
            if not variable_settings and not font_weight:
                variable_settings = {'wght': 400}  # 默认常规权重
            
            # 首先尝试使用确切的字体名称（可能包含权重）
            exact_font_family = font_family
            
            # 如果存在字体权重，并且font_family不包含权重信息，尝试构建包含权重的字体名称
            if font_weight and '-' not in font_family:
                # 权重映射到字体名称中常见的命名约定
                weight_name_map = {
                    'thin': 'Thin', 
                    'hairline': 'Hairline',
                    'extralight': 'ExtraLight',
                    'light': 'Light',
                    'regular': 'Regular',
                    'normal': 'Regular',
                    'medium': 'Medium',
                    'semibold': 'SemiBold',
                    'bold': 'Bold',
                    'extrabold': 'ExtraBold',
                    'black': 'Black',
                    '100': 'Thin',
                    '200': 'ExtraLight',
                    '300': 'Light',
                    '400': 'Regular',
                    '500': 'Medium',
                    '600': 'SemiBold',
                    '700': 'Bold',
                    '800': 'ExtraBold',
                    '900': 'Black'
                }
                
                # 尝试构建带权重的字体名称
                if isinstance(font_weight, str) and font_weight.lower() in weight_name_map:
                    weight_name = weight_name_map[font_weight.lower()]
                    weighted_font_family = f"{font_family}-{weight_name}"
                    
                    # 检查此名称的字体是否存在于字体映射中
                    if weighted_font_family in self.font_map:
                        exact_font_family = weighted_font_family
                        logger.debug(f"Using font with weight in name: {exact_font_family}")
                    else:
                        logger.debug(f"Weighted font name not found: {weighted_font_family}, using base family with variable settings")
                elif isinstance(font_weight, (int, float)) or (isinstance(font_weight, str) and font_weight.isdigit()):
                    # 数字权重转为名称
                    weight_num = int(font_weight) if isinstance(font_weight, str) else font_weight
                    weight_key = str(int(weight_num / 100) * 100)  # 四舍五入到最近的100
                    
                    if weight_key in weight_name_map:
                        weight_name = weight_name_map[weight_key]
                        weighted_font_family = f"{font_family}-{weight_name}"
                        
                        if weighted_font_family in self.font_map:
                            exact_font_family = weighted_font_family
                            logger.debug(f"Using font with weight in name: {exact_font_family}")
                        else:
                            logger.debug(f"Weighted font name not found: {weighted_font_family}, using base family with variable settings")
            
            # 获取字体，应用可变字体设置（如果有）
            font = self._get_pil_font(exact_font_family, scaled_font_size, variable_settings)
            
            # 如果没有找到带权重的字体，但有权重设置，使用基本字体名称再次尝试
            if font == ImageFont.load_default() and exact_font_family != font_family:
                logger.debug(f"Falling back to base font family: {font_family}")
                font = self._get_pil_font(font_family, scaled_font_size, variable_settings)
            
            # Get position attributes
            circular_text = False
            radius = 0
            start_angle = 0
            baseline_position = 'inside'  # New parameter, default to inside
            letter_spacing = 1.0  # Default letter spacing (1.0 = normal)
            
            # Find position attributes from current element
            if current_element:
                position = current_element.get('position', {})
                circular_text = position.get('isCircular', False)
                if circular_text:
                    # 根据缩放比例调整半径
                    radius = position.get('radius', 200) * self.scale_factor
                    start_angle = position.get('startAngle', 0)
                    baseline_position = position.get('baselinePosition', 'inside')
                    letter_spacing = position.get('letterSpacing', 1.0)
                else:
                    # For non-circular text, get letter spacing from position
                    letter_spacing = position.get('letterSpacing', 1.0)
            
            # Convert color from hex to RGB
            rgb_color = self._hex_to_rgb(color) if isinstance(color, str) else color
            
            # 根据缩放比例调整坐标位置
            scaled_x = x * self.scale_factor
            scaled_y = y * self.scale_factor
            
            if circular_text:
                # Handle circular text rendering with scaled parameters
                self._draw_circular_text(img, text, font, scaled_font_size, scaled_x, scaled_y, rgb_color, radius, 
                                       start_angle, baseline_position, position, original_text)
            else:
                # Handle regular text rendering
                bbox = font.getbbox(text)
                text_width, text_height = bbox[2] - bbox[0], bbox[3] - bbox[1]
                
                # Get custom padding if specified
                custom_padding = None
                if current_element:
                    custom_padding = current_element.get('textPadding')
                
                # 检查文本是否超出可用宽度，并考虑缩放后的图像大小
                padding = int(50 * self.scale_factor)  # 缩放padding以匹配图像大小
                if custom_padding is not None:
                    padding = int(custom_padding * self.scale_factor)
                    
                max_available_width = self.width - padding
                if rotation % 180 != 0:
                    if rotation % 180 > 45 and rotation % 180 < 135:
                        max_available_width = self.height - padding
                
                # Scale down text if needed
                text_scale_factor = 1.0
                final_font_size = scaled_font_size
                if text_width > max_available_width:
                    text_scale_factor = max_available_width / text_width
                    adjusted_font_size = int(scaled_font_size * text_scale_factor)
                    final_font_size = adjusted_font_size
                    font = self._get_pil_font(exact_font_family, adjusted_font_size, variable_settings)
                    # Recalculate text dimensions
                    bbox = font.getbbox(text)
                    text_width, text_height = bbox[2] - bbox[0], bbox[3] - bbox[1]
                
                # Store the adjusted font size for this element
                if element_id and current_element:
                    # Calculate the actual font size (accounting for both scale_factor and text_scale_factor)
                    # We divide by scale_factor to get the size relative to the original template dimensions
                    actual_font_size = final_font_size / self.scale_factor
                    self.font_size_adjustments[element_id] = {
                        'originalSize': font_size,
                        'scaledSize': scaled_font_size,
                        'finalSize': final_font_size,
                        'adjustedSize': actual_font_size,
                        'scaleFactor': self.scale_factor,
                        'textScaleFactor': text_scale_factor
                    }
                    logger.debug(f"Font size adjustment for element {element_id}: original={font_size}, adjusted={actual_font_size}")
                
                # Calculate position based on alignment
                place_x = scaled_x
                if text_align == 'center':
                    # 使用更准确的方法计算文本宽度
                    # 获取左边界和右边界
                    left, top, right, bottom = font.getbbox(text)
                    # 使用实际边界计算文本宽度
                    actual_text_width = right - left
                    # 考虑左边界的偏移
                    place_x = scaled_x - (actual_text_width / 2) - left
                elif text_align == 'right':
                    left, _, right, _ = font.getbbox(text)
                    actual_text_width = right - left
                    place_x = scaled_x - actual_text_width - left
                
                place_y = scaled_y
                ascent, descent = font.getmetrics()
                if vert_align == 'top':
                    place_y = scaled_y
                elif vert_align == 'middle':
                    _, top, _, bottom = font.getbbox(text)
                    actual_text_height = bottom - top
                    place_y = scaled_y - actual_text_height / 2 - top
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
                    
                    # Apply custom padding if specified
                    if custom_padding is not None:
                        adaptive_padding = int(custom_padding * self.scale_factor)
                    
                    # 创建足够大的文本图像
                    txt_img = Image.new('RGBA', (text_width + 2*adaptive_padding, text_height + 2*adaptive_padding), (0, 0, 0, 0))
                    txt_draw = ImageDraw.Draw(txt_img)
                    
                    # 在文本图像中心绘制文本
                    txt_draw.text((adaptive_padding, adaptive_padding), text, font=font, fill=rgb_color)
                    
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
                    
                    # 如果不需要字间距调整，直接画文本
                    if letter_spacing == 1.0:
                        draw.text((place_x, place_y), text, font=font, fill=rgb_color)
                    else:
                        # 实现字间距调整
                        self._draw_text_with_letter_spacing(draw, text, font, place_x, place_y, rgb_color, letter_spacing)
                
        except Exception as e:
            logger.error(f"Error drawing text with PIL: {e}")
            # Fallback to simple text rendering
            try:
                draw = ImageDraw.Draw(img)
                default_font = self._get_pil_font('Arial', scaled_font_size)
                draw.text((scaled_x, scaled_y), text, font=default_font, fill=rgb_color)
            except Exception as fallback_error:
                logger.error(f"Fallback text rendering failed: {fallback_error}")

    def _draw_text_with_letter_spacing(self, draw, text, font, x, y, color, spacing):
        """Draw text with custom letter spacing"""
        x_offset = 0
        for char in text:
            # Get character dimensions
            bbox = font.getbbox(char)
            char_width = bbox[2] - bbox[0]
            
            # Draw the character
            draw.text((x + x_offset, y), char, font=font, fill=color)
            
            # Move to the next position with spacing
            x_offset += char_width + (char_width * (spacing - 1.0) * 0.5)

    def _draw_circular_text(self, img, text, font, font_size, center_x, center_y, color, radius, 
                          start_angle, baseline_position, position, original_text=None):
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
            
            # Find current text element to get custom padding
            custom_padding = None
            # 使用原始文本或转换后的文本来查找元素
            lookup_text = original_text if original_text is not None else text
            for element in self.text_elements:
                if element.get('value') == lookup_text:
                    custom_padding = element.get('textPadding')
                    break
            
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
                
                # Apply custom padding if specified
                if custom_padding is not None:
                    adaptive_padding = int(custom_padding * self.scale_factor)
                
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
                    
                    # 保存原始文本，用于在_draw_text_with_pil中匹配元素
                    original_text = text
                    
                    # Apply uppercase if specified
                    if element.get('isUppercase', False):
                        text = text.upper()
                    
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
                    self._draw_text_with_pil(img, text, font_family, font_size, x, y, color_str, rotation, text_align, vert_align, original_text)
                    
                except Exception as e:
                    logger.error(f"Error drawing text element: {e}")
            
            # 如果应用了缩放，考虑添加锐化处理以提高图像质量
            if self.scale_factor > 1.0:
                img = img.filter(ImageFilter.SHARPEN)
            
            # Convert to PNG
            output = BytesIO()
            img.save(output, format='PNG')
            data = output.getvalue()
            
            return data, None, self.font_size_adjustments
            
        except Exception as e:
            error_msg = f"Error generating PNG: {e}"
            logger.error(error_msg)
            return None, error_msg, None

    def save_to_file(self, filename=None):
        """Save the generated stamp to a file"""
        if not filename:
            # Generate a unique filename
            timestamp = int(time.time())
            filename = f"stamp_{timestamp}.png"
        elif not filename.lower().endswith('.png'):
            filename += '.png'
        
        # Generate the stamp
        data, error, font_size_adjustments = self.generate()
        if error:
            return None, error, None
        
        # Save to file
        output_path = os.path.join(self.output_dir, filename)
        try:
            with open(output_path, 'wb') as f:
                f.write(data)
            return f"/stamps/{filename}", None, font_size_adjustments
        except Exception as e:
            return None, f"Error saving stamp to file: {e}", None

def main():
    # Read JSON input from stdin
    try:
        input_data = json.loads(sys.stdin.read())
        
        # Create stamp generator
        generator = PNGStampGenerator(input_data)
        
        # Check if we need to save to file
        if 'filename' in input_data:
            # Save to file and return URL
            url, error, font_size_adjustments = generator.save_to_file(input_data['filename'])
            if error:
                print(json.dumps({'success': False, 'error': error}))
            else:
                result = {
                    'success': True,
                    'url': url
                }
                if font_size_adjustments:
                    result['fontSizeAdjustments'] = font_size_adjustments
                print(json.dumps(result))
        else:
            # Generate and return data as base64
            data, error, font_size_adjustments = generator.generate()
            if error:
                print(json.dumps({'success': False, 'error': error}))
            else:
                result = {
                    'success': True,
                    'data': base64.b64encode(data).decode('utf-8')
                }
                if font_size_adjustments:
                    result['fontSizeAdjustments'] = font_size_adjustments
                print(json.dumps(result))
                
    except Exception as e:
        # Return error as JSON
        print(json.dumps({'success': False, 'error': str(e)}))

if __name__ == "__main__":
    main() 