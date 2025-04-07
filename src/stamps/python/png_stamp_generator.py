#!/usr/bin/env python3
import sys
import json
import os
import base64
import time
import logging
from io import BytesIO
import math
import freetype
import numpy as np
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
        
        # Initialize glyph variant cache
        self.glyph_variant_cache = {}

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
                # 确保临时字体被添加到字体映射中
                self._register_temp_font(output_path)
                return output_path
                
            # 使用fontTools创建指定实例
            font = TTFont(font_path)
            instance_font = instancer.instantiateVariableFont(font, axis_values)
            instance_font.save(output_path)
            
            # 将临时字体添加到字体映射中
            self._register_temp_font(output_path)
            
            return output_path
        except Exception as e:
            logger.error(f"Error creating variable font instance: {e}")
            return None
            
    def _register_temp_font(self, font_path):
        """
        将临时生成的字体注册到字体映射中，确保后续可以找到它
        
        Parameters:
            font_path (str): 字体文件路径
        """
        try:
            # 从路径获取字体名称
            font_name = os.path.basename(font_path)
            font_name_without_ext = os.path.splitext(font_name)[0]
            
            # 避免重复注册
            if font_name_without_ext in self.font_map:
                return
                
            # 分析字体
            is_variable, axes_info = self._analyze_font(font_path)
            
            # 注册到字体映射
            self.font_map[font_name_without_ext] = {
                'path': font_path,
                'isVariableFont': is_variable,
                'variableAxes': axes_info,
                'isTemporary': True  # 标记为临时字体
            }
            
            logger.info(f"临时字体已注册: {font_name_without_ext} -> {font_path}")
        except Exception as e:
            logger.error(f"注册临时字体失败: {e}")

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
            first_variant = None  # 首字符变体
            last_variant = None   # 尾字符变体
            custom_padding = None # 自定义padding
            
            # 使用原始文本或转换后的文本来查找元素
            lookup_text = original_text if original_text is not None else text
            
            for element in self.text_elements:
                if element.get('value') == lookup_text:
                    current_element = element
                    position = element.get('position', {})
                    element_id = element.get('id')
                    
                    # 获取首尾字符变体设置
                    first_variant = element.get('firstVariant')
                    last_variant = element.get('lastVariant')
                    
                    # 获取自定义padding
                    custom_padding = element.get('textPadding')
                    
                    # 保存字体权重信息，无论是否为可变字体都可能会用到
                    font_weight = element.get('fontWeight')
                    
                    # 检查是否有可变字体设置
                    if 'variableFontSettings' in element:
                        variable_settings = element.get('variableFontSettings')
                        logger.debug(f"Using explicit variableFontSettings: {variable_settings}")
                    break
            
            # 获取字体信息
            font_info = self._get_font_info(font_family)
            if not font_info:
                logger.error(f"Could not get font info for {font_family}")
                return
                
            font_path = font_info.get('path')
            if not font_path or not os.path.exists(font_path):
                logger.error(f"Font path does not exist: {font_path}")
                return
            
            # 计算边距
            margin = int(10 * self.scale_factor)  # 默认边距(单侧)
            if custom_padding is not None:
                margin = int((custom_padding / 2) * self.scale_factor)  # 除以2，因为 padding 是两侧总和
            
            # 如果指定了首尾变体，使用 FreeType 渲染
            if first_variant is not None or last_variant is not None:
                try:
                    # 渲染带有变体的文本
                    rendered_text = self._render_text_with_variants(text, font_path, scaled_font_size, first_variant, last_variant)
                    if rendered_text:
                        # 获取渲染后的文本尺寸
                        text_width, text_height = rendered_text.size
                        
                        # 如果文本太宽，进行缩放
                        if text_width > self.width - (margin * 2):
                            scale_factor = (self.width - (margin * 2)) / text_width
                            new_width = int(text_width * scale_factor)
                            new_height = int(text_height * scale_factor)
                            rendered_text = rendered_text.resize((new_width, new_height), Image.LANCZOS)
                            text_width, text_height = new_width, new_height
                        
                        # 计算初始位置（基于未缩放的坐标）
                        place_x = x * self.scale_factor
                        place_y = y * self.scale_factor
                        
                        # 根据对齐方式调整位置
                        if text_align == 'center':
                            place_x = (self.width - text_width) / 2
                        elif text_align == 'right':
                            place_x = self.width - text_width - margin
                        else:  # 'left'
                            place_x = margin
                            
                        if vert_align == 'middle':
                            place_y = (self.height - text_height) / 2
                        elif vert_align == 'bottom':
                            place_y = self.height - text_height - margin
                        else:  # 'top' or 'baseline'
                            place_y = margin
                        
                        # 如果需要旋转
                        if rotation != 0:
                            # 创建一个新的透明图像用于旋转
                            padding = max(text_width, text_height)
                            rot_img = Image.new('RGBA', (padding * 2, padding * 2), (0, 0, 0, 0))
                            # 将文本粘贴到中心
                            paste_x = padding - text_width // 2
                            paste_y = padding - text_height // 2
                            rot_img.paste(rendered_text, (paste_x, paste_y), rendered_text)
                            # 旋转
                            rotated = rot_img.rotate(-rotation, expand=True, resample=Image.BICUBIC)
                            
                            # 计算旋转后的边界框
                            rotated_width, rotated_height = rotated.size
                            
                            # 计算新的粘贴位置，确保在可用区域内居中
                            final_x = int((self.width - rotated_width) / 2)
                            final_y = int((self.height - rotated_height) / 2)
                            
                            # 确保不超出边界
                            final_x = max(margin, min(final_x, self.width - rotated_width - margin))
                            final_y = max(margin, min(final_y, self.height - rotated_height - margin))
                            
                            # 粘贴到主图像
                            img.paste(rotated, (final_x, final_y), rotated)
                        else:
                            # 直接粘贴，位置已经考虑了边距
                            img.paste(rendered_text, (int(place_x), int(place_y)), rendered_text)
                        return
                except Exception as e:
                    logger.error(f"Error rendering text with variants: {e}")
                    # 如果变体渲染失败，回退到普通渲染
            
            # 如果没有指定变体或变体渲染失败，使用普通的PIL渲染
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
                
                # 边界检查：确保文本不会超出图像边界，并保持边距
                # 定义边距，确保文本不会紧贴边界
                margin = int(10 * self.scale_factor)  # 默认边距(单侧)
                
                # 使用自定义 padding 如果有指定 (将总 padding 分为两侧)
                if custom_padding is not None:
                    margin = int((custom_padding / 2) * self.scale_factor)  # 除以2，因为 padding 是两侧总和
                    
                # 计算可用宽度 (两侧都减去 margin)
                max_available_width = self.width - (margin * 2)
                if rotation % 180 != 0:
                    if rotation % 180 > 45 and rotation % 180 < 135:
                        max_available_width = self.height - (margin * 2)
                
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
                    
                    # 边界检查：确保文本不会超出图像边界，并保持边距
                    # 定义边距，确保文本不会紧贴边界
                    margin = int(10 * self.scale_factor)  # 默认边距(单侧)
                    
                    # 使用自定义 padding 如果有指定 (将总 padding 分为两侧)
                    if custom_padding is not None:
                        margin = int((custom_padding / 2) * self.scale_factor)  # 除以2，因为 padding 是两侧总和
                        
                    if place_x < margin:
                        place_x = margin
                    elif place_x + actual_text_width > self.width - margin:
                        place_x = max(margin, self.width - actual_text_width - margin)
                        
                elif text_align == 'right':
                    left, _, right, _ = font.getbbox(text)
                    actual_text_width = right - left
                    place_x = scaled_x - actual_text_width - left
                    
                    # 边界检查：确保文本不会超出图像边界，并保持边距
                    # 定义边距，确保文本不会紧贴边界
                    margin = int(10 * self.scale_factor)  # 默认边距(单侧)
                    
                    # 使用自定义 padding 如果有指定 (将总 padding 分为两侧)
                    if custom_padding is not None:
                        margin = int((custom_padding / 2) * self.scale_factor)  # 除以2，因为 padding 是两侧总和
                        
                    if place_x < margin:
                        place_x = margin
                    elif place_x + actual_text_width > self.width - margin:
                        place_x = max(margin, self.width - actual_text_width - margin)
                else:  # 'left' alignment
                    # 对于左对齐，也进行边界检查
                    left, _, right, _ = font.getbbox(text)
                    actual_text_width = right - left
                    
                    # 边界检查：确保文本不会超出图像边界，并保持边距
                    # 定义边距，确保文本不会紧贴边界
                    margin = int(10 * self.scale_factor)  # 默认边距(单侧)
                    
                    # 使用自定义 padding 如果有指定 (将总 padding 分为两侧)
                    if custom_padding is not None:
                        margin = int((custom_padding / 2) * self.scale_factor)  # 除以2，因为 padding 是两侧总和
                        
                    if place_x < margin:
                        place_x = margin
                    elif place_x + actual_text_width > self.width - margin:
                        place_x = max(margin, self.width - actual_text_width - margin)
                
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
                    
                    # 修复：确保文本不会超出边界，并保持边距
                    # 定义边距，确保文本不会紧贴边界
                    margin = int(10 * self.scale_factor)  # 默认边距(单侧)
                    
                    # 使用自定义 padding 如果有指定 (将总 padding 分为两侧)
                    if custom_padding is not None:
                        margin = int((custom_padding / 2) * self.scale_factor)  # 除以2，因为 padding 是两侧总和
                        
                    # 检查左边界
                    if paste_x < margin:
                        paste_x = margin
                    # 检查右边界
                    if paste_x + rotated_txt.width > self.width - margin:
                        paste_x = max(margin, self.width - rotated_txt.width - margin)
                    # 检查上边界
                    if paste_y < margin:
                        paste_y = margin
                    # 检查下边界
                    if paste_y + rotated_txt.height > self.height - margin:
                        paste_y = max(margin, self.height - rotated_txt.height - margin)
                    
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
                        # 修复：确保文本是否会超出边界，并保持边距
                        # 定义边距，确保文本不会紧贴边界
                        margin = int(10 * self.scale_factor)  # 默认边距(单侧)
                        
                        # 使用自定义 padding 如果有指定 (将总 padding 分为两侧)
                        if custom_padding is not None:
                            margin = int((custom_padding / 2) * self.scale_factor)  # 除以2，因为 padding 是两侧总和
                        
                        # 检查是否会超出左边界
                        if place_x < margin:
                            place_x = margin
                        # 检查是否会超出右边界
                        elif place_x + text_width > self.width - margin:
                            place_x = max(margin, self.width - text_width - margin)
                            
                        draw.text((place_x, place_y), text, font=font, fill=rgb_color)
                    else:
                        # 获取整个文本的边界框，用于边界检查
                        left, top, right, bottom = font.getbbox(text)
                        text_actual_width = right - left
                        
                        # 修复：确保文本是否会超出边界，并保持边距
                        # 定义边距，确保文本不会紧贴边界
                        margin = int(10 * self.scale_factor)  # 默认边距(单侧)
                        
                        # 使用自定义 padding 如果有指定 (将总 padding 分为两侧)
                        if custom_padding is not None:
                            margin = int((custom_padding / 2) * self.scale_factor)  # 除以2，因为 padding 是两侧总和
                        
                        # 检查是否会超出左边界
                        if place_x < margin:
                            place_x = margin
                        # 检查是否会超出右边界
                        elif place_x + text_actual_width > self.width - margin:
                            place_x = max(margin, self.width - text_actual_width - margin)
                            
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
            
            # 获取最大角度限制(默认360度，即整圆)
            max_angle_raw = position.get('maxAngle')
            if max_angle_raw is not None:
                try:
                    # 尝试将maxAngle转换为数值类型
                    max_angle_limit = float(max_angle_raw)
                    logger.info(f"从JSON中获取maxAngle参数: {max_angle_raw}, 转换为: {max_angle_limit}")
                except (ValueError, TypeError):
                    # 如果转换失败，使用默认值
                    max_angle_limit = 360
                    logger.warning(f"无法将maxAngle参数转换为数值: {max_angle_raw}, 使用默认值: {max_angle_limit}")
            else:
                # 如果没有设置，使用默认值
                max_angle_limit = 360
                logger.info(f"未设置maxAngle参数，使用默认值: {max_angle_limit}")
                
            # 确保最大角度在有效范围内
            max_angle_limit = min(max(0, max_angle_limit), 360)
            
            # 添加调试日志
            logger.info(f"圆形文本参数 - text: '{text}', maxAngle: {max_angle_limit}, radius: {radius}")
            
            # Adjust text sequence based on baseline position
            reverse_text = baseline_position == 'outside'
            text_to_render = text[::-1] if reverse_text else text
            
            # 计算文本参数并检查是否需要缩放
            def calculate_text_metrics(current_font, current_font_size):
                # Calculate text metrics for spacing
                total_width = 0
                char_widths = []
                char_heights = []
                
                for char in text_to_render:
                    bbox = current_font.getbbox(char)
                    width = bbox[2] - bbox[0]
                    height = bbox[3] - bbox[1]
                    char_widths.append(width)
                    char_heights.append(height)
                    total_width += width
                
                # 计算最大字符高度，用于设置足够的内外边距
                max_char_height = max(char_heights) if char_heights else 0
                
                # 计算文本在圆周上占据的角度
                circumference = 2 * math.pi * radius
                text_arc_ratio = total_width / circumference
                
                # 应用间距调整
                base_spacing = 1.0
                spacing_factor = base_spacing * letter_spacing
                
                # 根据文本长度微调间距
                original_spacing_factor = spacing_factor
                if text_arc_ratio < 0.1:
                    spacing_factor *= 1.1
                elif text_arc_ratio > 0.5:
                    spacing_factor *= 0.95
                
                # 字体特定调整
                pre_font_spacing_factor = spacing_factor
                font_family_lower = current_font.path.lower()
                if 'montserrat' in font_family_lower or 'arial' in font_family_lower or 'helvetica' in font_family_lower:
                    spacing_factor *= 1.05
                
                # 计算总角度
                total_angle_rad = (total_width / radius) * spacing_factor
                total_angle_deg = total_angle_rad * (180 / math.pi)
                
                logger.debug(f"角度计算详情: radius={radius}, total_width={total_width}, text_arc_ratio={text_arc_ratio:.4f}, " +
                            f"original_spacing={original_spacing_factor:.4f}, after_len_adjust={pre_font_spacing_factor:.4f}, " + 
                            f"final_spacing={spacing_factor:.4f}, total_angle_deg={total_angle_deg:.2f}")
                
                return char_widths, char_heights, total_width, max_char_height, total_angle_deg, spacing_factor
            
            # 首次计算文本度量
            char_widths, char_heights, total_width, max_char_height, total_angle_deg, spacing_factor = calculate_text_metrics(font, font_size)
            
            # 添加调试日志
            logger.info(f"圆形文本计算结果 - total_angle_deg: {total_angle_deg}, spacing_factor: {spacing_factor}, total_width: {total_width}")
            
            # 检查是否超过最大角度，如果超过则缩小字体
            if max_angle_limit > 0 and total_angle_deg > max_angle_limit:
                # 添加调试日志
                logger.info(f"圆形文本需要缩放 - 当前角度: {total_angle_deg}, 最大限制: {max_angle_limit}")
                
                # 计算需要的缩放比例
                scale_factor = max_angle_limit / total_angle_deg
                
                # 计算新的字体大小
                adjusted_font_size = int(font_size * scale_factor)
                # 确保字体大小不会太小
                adjusted_font_size = max(8, adjusted_font_size)
                
                logger.info(f"圆形文本字体缩放 - 原始大小: {font_size}, 调整后: {adjusted_font_size}, 缩放比例: {scale_factor}")
                
                # 获取缩小后的字体
                element_id = None
                if original_text:
                    # 找到对应的元素以记录字体调整信息
                    for element in self.text_elements:
                        if element.get('value') == original_text:
                            element_id = element.get('id')
                            break
                
                # 找到当前字体的字体名
                current_font_family = None
                for name, info in self.font_map.items():
                    if info.get('path') == font.path:
                        current_font_family = name
                        logger.info(f"找到匹配的字体: {name} -> {font.path}")
                        break
                
                if not current_font_family:
                    # 如果无法找到字体名，使用路径中的文件名
                    font_name = os.path.basename(font.path)
                    current_font_family = os.path.splitext(font_name)[0]
                    logger.info(f"无法在字体映射中找到字体，使用文件名: {current_font_family}")
                    
                    # 确保这个字体被注册到字体映射中
                    if not any(info.get('path') == font.path for info in self.font_map.values()):
                        self._register_temp_font(font.path)
                        logger.info(f"将未映射的字体添加到字体映射: {current_font_family}")
                
                # 应用新字体大小
                logger.info(f"准备获取新字体: 字体名={current_font_family}, 调整后大小={adjusted_font_size}")
                
                # 检查是否为可变字体
                is_variable_font = False
                variable_settings = None
                for element in self.text_elements:
                    if element.get('value') == original_text:
                        # 检查是否有可变字体设置
                        if 'variableFontSettings' in element:
                            is_variable_font = True
                            variable_settings = element.get('variableFontSettings')
                            logger.info(f"检测到可变字体设置: {variable_settings}")
                        # 检查字体权重
                        if 'fontWeight' in element:
                            font_weight = element.get('fontWeight')
                            logger.info(f"检测到字体权重: {font_weight}")
                            if not variable_settings:
                                # 从fontWeight创建变量设置
                                wght_value = 400  # 默认值
                                
                                # 字符串形式的权重处理
                                if isinstance(font_weight, str):
                                    if font_weight.lower() == 'bold':
                                        wght_value = 700
                                    elif font_weight.lower() == 'medium':
                                        wght_value = 500
                                    elif font_weight.isdigit():
                                        wght_value = int(font_weight)
                                # 数字形式的权重处理
                                elif isinstance(font_weight, (int, float)):
                                    wght_value = int(font_weight)
                                    
                                variable_settings = {'wght': wght_value}
                                logger.info(f"从字体权重创建变量设置: {variable_settings}")
                        break
                        
                # 获取调整后的字体
                adjusted_font = self._get_pil_font(current_font_family, adjusted_font_size, variable_settings)
                # 检查是否成功获取字体
                if adjusted_font == ImageFont.load_default():
                    logger.warning(f"无法加载调整后的字体，使用默认字体")
                    
                    # 如果加载失败，尝试将该字体直接加载为普通字体
                    try:
                        adjusted_font = ImageFont.truetype(font.path, int(adjusted_font_size))
                        logger.info(f"使用原始字体路径加载调整后的字体: {font.path}")
                    except Exception as e:
                        logger.error(f"尝试直接加载字体失败: {e}")
                else:
                    logger.info(f"成功加载调整后的字体: {adjusted_font.path}, 大小: {adjusted_font_size}")
                
                # 应用调整后的字体
                font = adjusted_font
                
                # 更新字体大小值用于后续计算
                font_size = adjusted_font_size
                
                # 记录字体调整
                if element_id:
                    # 计算原始大小（不含缩放比例影响）
                    original_font_size = font_size / self.scale_factor
                    # 计算调整后的大小（不含缩放比例影响）
                    adjusted_original_size = adjusted_font_size / self.scale_factor
                    
                    self.font_size_adjustments[element_id] = {
                        'originalSize': original_font_size,
                        'scaledSize': font_size,  # 包含全局缩放的调整前大小
                        'finalSize': adjusted_font_size,  # 实际使用的最终大小（包含全局缩放）
                        'adjustedSize': adjusted_original_size,  # 不含全局缩放的调整后大小
                        'scaleFactor': scale_factor,
                        'globalScaleFactor': self.scale_factor,
                        'reason': 'circular_text_max_angle',
                        'maxAngle': max_angle_limit,
                        'calculatedAngle': total_angle_deg
                    }
                
                # 重新计算所有度量
                logger.info(f"重新计算调整后文本度量 - 原始角度: {total_angle_deg}, 期望最大角度: {max_angle_limit}")
                prev_total_width = total_width  # 保存调整前的总宽度
                prev_total_angle = total_angle_deg  # 保存调整前的总角度
                
                # 重新计算
                char_widths, char_heights, total_width, max_char_height, total_angle_deg, spacing_factor = calculate_text_metrics(font, font_size)
                
                # 检查重新计算结果是否达到预期
                width_change_ratio = total_width / prev_total_width if prev_total_width > 0 else 0
                angle_change_ratio = total_angle_deg / prev_total_angle if prev_total_angle > 0 else 0
                
                logger.info(f"重新计算结果 - 新宽度: {total_width}, 宽度变化比例: {width_change_ratio:.4f}")
                logger.info(f"重新计算结果 - 新角度: {total_angle_deg}, 角度变化比例: {angle_change_ratio:.4f}")
                logger.info(f"是否满足要求: {'是' if total_angle_deg <= max_angle_limit else '否'}")
                
                # 如果仍然超出限制，记录警告
                if total_angle_deg > max_angle_limit:
                    logger.warning(f"字体调整后仍然超出限制 - 当前角度: {total_angle_deg}, 限制: {max_angle_limit}")
            
            # 确保我们使用最终的total_angle_deg
            final_total_angle_deg = total_angle_deg
            
            # Determine starting angle based on layout mode
            if layout_mode == 'centerAligned':
                start_angle = (base_angle - final_total_angle_deg/2) % 360
                logger.info(f"圆形文本居中对齐 - base_angle: {base_angle}, final_total_angle_deg: {final_total_angle_deg}, start_angle: {start_angle}")
            else:
                start_angle = base_angle
                logger.info(f"圆形文本起点对齐 - base_angle: {base_angle}, start_angle: {start_angle}")
            
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
                # 使用最终的计算角度进行调整
                adjustment_ratio = final_total_angle_deg / total_actual_angle
                logger.info(f"调整字符分布 - total_actual_angle: {total_actual_angle}, final_total_angle_deg: {final_total_angle_deg}, adjustment_ratio: {adjustment_ratio}")
                
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

    def _analyze_font_variants(self, font_path):
        """分析字体的变体（字型）信息"""
        try:
            # 使用 fontTools 加载字体
            tt = TTFont(font_path)
            glyph_set = tt.getGlyphOrder()
            
            # 创建字形名称到索引的映射
            glyph_variants = {}
            
            # 遍历所有字形，查找变体
            for glyph_name in glyph_set:
                # 检查基本字符和其变体（例如：a, a.1, a.2 等）
                base_char = glyph_name.split('.')[0]
                if len(base_char) == 1:  # 只处理单个字符的变体
                    if base_char not in glyph_variants:
                        glyph_variants[base_char] = []
                    glyph_variants[base_char].append(glyph_name)
            
            # 对每个字符的变体进行排序
            for char in glyph_variants:
                glyph_variants[char].sort()
            
            return glyph_variants
        except Exception as e:
            logger.error(f"Error analyzing font variants: {e}")
            return {}

    def _get_glyph_variant(self, char, variant_index, font_path):
        """获取指定字符的特定变体"""
        try:
            # 检查缓存
            cache_key = (font_path, char)
            if cache_key not in self.glyph_variant_cache:
                # 分析字体变体并缓存结果
                self.glyph_variant_cache[cache_key] = self._analyze_font_variants(font_path).get(char, [char])
            
            variants = self.glyph_variant_cache[cache_key]
            
            # 如果指定了有效的变体索引，返回对应的变体
            if variant_index is not None and 0 <= variant_index < len(variants):
                return variants[variant_index]
            
            # 否则返回默认变体（通常是第一个）
            return variants[0]
        except Exception as e:
            logger.error(f"Error getting glyph variant: {e}")
            return char

    def _render_text_with_variants(self, text, font_path, font_size, first_variant=None, last_variant=None):
        """使用指定的首尾变体渲染文本"""
        try:
            # 初始化 FreeType 字体
            face = freetype.Face(font_path)
            face.set_char_size(int(font_size * 64))  # 设置字体大小
            
            # 加载字体以获取字形映射
            tt = TTFont(font_path)
            glyph_set = tt.getGlyphOrder()
            glyph_name_to_index = {name: i for i, name in enumerate(glyph_set)}
            
            # 获取字体度量信息
            ascender = face.ascender / 64  # 转换为像素
            descender = face.descender / 64
            height = face.height / 64
            
            # 首先遍历一次计算总体尺寸和收集字形信息
            total_width = 0
            max_height = 0
            min_y = float('inf')
            max_y = float('-inf')
            glyph_positions = []
            
            # 第一遍：收集所有字形信息
            for i, char in enumerate(text):
                # 确定是否使用变体
                variant_index = None
                if i == 0 and first_variant is not None:
                    variant_index = first_variant
                elif i == len(text) - 1 and last_variant is not None:
                    variant_index = last_variant
                
                # 获取变体字形名称
                glyph_name = self._get_glyph_variant(char, variant_index, font_path)
                
                # 获取字形索引并加载字形
                glyph_index = glyph_name_to_index.get(glyph_name, glyph_name_to_index.get(char, 0))
                face.load_glyph(glyph_index, freetype.FT_LOAD_RENDER)
                
                bitmap = face.glyph.bitmap
                metrics = face.glyph.metrics
                
                # 计算字形的垂直范围
                glyph_top = face.glyph.bitmap_top
                glyph_bottom = glyph_top - bitmap.rows
                min_y = min(min_y, glyph_bottom)
                max_y = max(max_y, glyph_top)
                
                # 使用实际的水平步进
                advance_x = metrics.horiAdvance / 64
                
                # 存储字形信息
                glyph_positions.append({
                    'width': bitmap.width,
                    'height': bitmap.rows,
                    'glyph_index': glyph_index,
                    'advance_x': advance_x,
                    'bitmap_left': face.glyph.bitmap_left,
                    'bitmap_top': face.glyph.bitmap_top,
                    'bearing_x': metrics.horiBearingX / 64,
                    'bearing_y': metrics.horiBearingY / 64
                })
                
                total_width += advance_x
            
            # 计算实际需要的图像高度
            actual_height = max_y - min_y
            
            # 创建最终图像，添加额外的空间用于字形溢出
            extra_space = int(font_size * 0.5)  # 增加额外空间
            img_width = int(total_width + extra_space * 2)
            img_height = int(actual_height + extra_space * 2)
            img = Image.new('RGBA', (img_width, img_height), (0, 0, 0, 0))
            
            # 从左边的额外空间开始
            x_offset = extra_space
            
            # 第二遍：渲染字形
            for pos in glyph_positions:
                face.load_glyph(pos['glyph_index'], freetype.FT_LOAD_RENDER)
                bitmap = face.glyph.bitmap
                
                if bitmap.width > 0 and bitmap.rows > 0:
                    # 转换为 numpy 数组
                    glyph_array = np.array(bitmap.buffer, dtype=np.uint8).reshape((bitmap.rows, bitmap.width))
                    # 转换为 PIL 图像
                    glyph_img = Image.fromarray(glyph_array, mode='L')
                    # 转换为 RGBA
                    glyph_rgba = Image.new('RGBA', glyph_img.size, (0, 0, 0, 0))
                    glyph_rgba.putalpha(glyph_img)
                    
                    # 计算字形的精确位置
                    # 水平位置：考虑字形的左轴承
                    x_pos = x_offset + pos['bitmap_left']
                    
                    # 垂直位置：将字形对齐到基线
                    # 基线位置在图像中的位置（从顶部开始）
                    baseline_y = extra_space + max_y
                    # 从基线减去 bitmap_top 得到顶部位置
                    y_pos = baseline_y - pos['bitmap_top']
                    
                    # 粘贴到主图像
                    img.paste(glyph_rgba, (int(x_pos), int(y_pos)), glyph_rgba)
                
                # 更新水平位置
                x_offset += pos['advance_x']
            
            return img
        except Exception as e:
            logger.error(f"Error rendering text with variants: {e}")
            return None

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