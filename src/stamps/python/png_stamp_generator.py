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
            is_autobold_enabled = False
            
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
                    
                    # If autoBold is true, override font weight to bold
                    if element.get('autoBold', False):
                        is_autobold_enabled = True
                        font_weight = 'bold'
                        logger.debug(f"autoBold is True for element {element_id}, setting fontWeight to 'bold'")
                    
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
            
            # 如果启用了自动加粗，则计算描边宽度
            stroke_width = 0
            if is_autobold_enabled:
                stroke_width = max(1, int(scaled_font_size * 0.025))
            
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
                        # 调整y坐标，使其与PIL一致（从底部开始计算）
                        place_y = (y * self.scale_factor) - (text_height * 0.8)
                        
                        # 根据对齐方式调整位置，保持与标准文本渲染一致的逻辑
                        if text_align == 'center':
                            # 在当前x位置居中对齐
                            place_x = place_x - (text_width / 2)
                        elif text_align == 'right':
                            # 在当前x位置右对齐
                            place_x = place_x - text_width
                        # 对于'left'，不需要调整，默认就是左对齐
                            
                        if vert_align == 'middle':
                            # 在当前y位置垂直居中（注意y已经是从底部计算的）
                            place_y = place_y + (text_height / 2)
                        elif vert_align == 'top':
                            # 在当前y位置顶对齐（注意y已经是从底部计算的）
                            place_y = place_y + text_height
                        # 对于'bottom'或'baseline'，使用当前y位置，因为已经是从底部计算的
                        
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
                            
                            # 使用原始位置作为旋转中心，考虑到y是从底部计算的
                            final_x = int(place_x - (rotated_width / 2) + (text_width / 2))
                            final_y = int(place_y - (rotated_height / 2) + (text_height / 2))
                            
                            # 粘贴到主图像，不强制限制在边界内
                            img.paste(rotated, (final_x, final_y), rotated)
                        else:
                            # 直接粘贴，使用计算的位置，不强制限制在边界内
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
                                       start_angle, baseline_position, position, original_text, stroke_width=stroke_width)
            else:
                # Handle regular text rendering
                # Get a Draw object to measure text
                draw = ImageDraw.Draw(img) 

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
                
                # Calculate text width with letter spacing
                text_scale_factor = 1.0
                final_font_size = scaled_font_size
                
                # First calculate base width using textlength for better accuracy
                base_width = draw.textlength(text, font=font)
                
                # Calculate letter spacing adjustment separately if needed
                # Note: textlength *might* already account for some kerning.
                # We'll add explicit spacing based on letter_spacing factor.
                spacing_width = 0
                if letter_spacing != 1.0 and len(text) > 1:
                     # Calculate the width without any letter spacing adjustments first
                    base_width_no_spacing = base_width # Use the previously calculated base_width
                    # Calculate the adjustment needed based on the difference and the factor
                    # This is an approximation, as ideal spacing depends on character pairs
                    spacing_width = base_width_no_spacing * (letter_spacing - 1.0)

                text_width = base_width + spacing_width
                
                # 为 faux bold 添加额外的宽度
                if stroke_width > 0:
                    text_width += 2 * stroke_width
                
                # Calculate the actual space needed including padding
                # Since padding is split between left and right sides, we need to consider both sides
                total_width_with_padding = text_width + (margin * 2)  # Add padding for both sides
                
                # Scale down text if needed
                if total_width_with_padding > self.width:  # Compare with full width
                    # Calculate scale factor based on width minus total padding
                    text_scale_factor = (self.width - (margin * 2)) / text_width
                    adjusted_font_size = int(scaled_font_size * text_scale_factor)
                    # Prevent font size from becoming too small
                    final_font_size = max(8, adjusted_font_size) # Ensure minimum font size
                    font = self._get_pil_font(exact_font_family, final_font_size, variable_settings)
                    
                    # Recalculate text dimensions with new font size
                    base_width = draw.textlength(text, font=font)
                    spacing_width = 0
                    if letter_spacing != 1.0 and len(text) > 1:
                        # Use the recalculated base_width
                        base_width_no_spacing = base_width 
                        spacing_width = base_width_no_spacing * (letter_spacing - 1.0)
                    text_width = base_width + spacing_width
                    # 为 faux bold 添加额外的宽度
                    if stroke_width > 0:
                        text_width += 2 * stroke_width
                    total_width_with_padding = text_width + (margin * 2)
                
                # Get text height using getbbox as textlength doesn't provide height
                # We still need bbox for height calculation and vertical alignment
                # Use a temporary draw object on a dummy image if needed, but using the main one is fine here
                bbox = font.getbbox(text) 
                # Defensive check for valid bbox
                if bbox:
                   text_height = bbox[3] - bbox[1]
                else:
                   # Fallback if getbbox fails for some reason
                   ascent, descent = font.getmetrics()
                   text_height = ascent + descent

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
                    # Center align the text at the user-specified x position
                    place_x = scaled_x - (text_width / 2)
                elif text_align == 'right':
                    # Right align the text at the user-specified x position
                    place_x = scaled_x - text_width
                else:  # 'left' alignment
                    # Use the user-specified x position directly for left alignment
                    place_x = scaled_x 
                
                # Ensure we don't exceed margins AFTER alignment is calculated
                if place_x < margin:
                    place_x = margin
                elif place_x + text_width > self.width - margin:
                    place_x = self.width - text_width - margin
                
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
                    txt_draw.text((adaptive_padding, adaptive_padding), text, font=font, fill=rgb_color, stroke_width=stroke_width)
                    
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
                            
                        draw.text((place_x, place_y), text, font=font, fill=rgb_color, stroke_width=stroke_width)
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
                            
                        self._draw_text_with_letter_spacing(draw, text, font, place_x, place_y, rgb_color, letter_spacing, stroke_width=stroke_width)
                
        except Exception as e:
            logger.error(f"Error drawing text with PIL: {e}")
            # Fallback to simple text rendering
            try:
                draw = ImageDraw.Draw(img)
                default_font = self._get_pil_font('Arial', scaled_font_size)
                draw.text((scaled_x, scaled_y), text, font=default_font, fill=rgb_color)
            except Exception as fallback_error:
                logger.error(f"Fallback text rendering failed: {fallback_error}")

    def _draw_text_with_letter_spacing(self, draw, text, font, x, y, color, spacing, stroke_width=0):
        """Draw text with custom letter spacing"""
        # Use textlength for better width calculation
        char_advances = [draw.textlength(char, font=font) for char in text]
        
        # Calculate total extra space based on the spacing factor
        # The spacing factor applies to the *default* spacing/advance.
        # Example: spacing=1.2 means 20% extra space per gap.
        # Default advance already includes minimal spacing. We add extra space.
        num_gaps = len(text) - 1
        if num_gaps <= 0:
             # No gaps, draw normally
             draw.text((x, y), text, font=font, fill=color, stroke_width=stroke_width)
             return

        # Calculate the average advance width to determine extra space per gap
        # This is an approximation, but better than using bbox.
        # A more robust way might involve font metrics, but textlength is accessible.
        avg_advance = sum(char_advances) / len(char_advances) if char_advances else 0
        extra_space_per_gap = avg_advance * (spacing - 1.0)

        # Draw each character with the calculated spacing
        current_x = x
        for i, char in enumerate(text):
            # Draw the character
            draw.text((current_x, y), char, font=font, fill=color, stroke_width=stroke_width)
            
            # Move to the next position using the character's advance and extra spacing
            if i < num_gaps:  # Add spacing only between characters
                current_x += char_advances[i] + extra_space_per_gap

    def _draw_circular_text(self, img, text, font, font_size, center_x, center_y, color, radius, 
                          start_angle, baseline_position, position, original_text=None, stroke_width=0):
        """Draw text in a circular path using Freetype for precise metrics."""
        try:
            # --- Freetype-based Layout Engine ---
            
            layout_mode = position.get('layoutMode', 'startAligned')
            base_angle = position.get('baseAngle', 0)
            letter_spacing_factor = position.get('letterSpacing', 1.0)
            max_angle_limit = position.get('maxAngle', 360)
            if not isinstance(max_angle_limit, (int, float)):
                max_angle_limit = 360
            max_angle_limit = min(max(0, max_angle_limit), 360)

            # Reverse text if rendering on the outside of the circle
            text_to_render = text[::-1] if baseline_position == 'outside' else text

            # Helper to get a Freetype face object
            def get_face(font_path, size):
                face = freetype.Face(font_path)
                face.set_char_size(int(size * 64))
                return face

            # --- Font Size Scaling Loop ---
            # This loop adjusts font size to fit text within max_angle_limit
            
            current_font_size = font_size
            final_font = font
            total_angle_deg = 0
            
            # Limit iterations to prevent infinite loops
            for _ in range(10): 
                face = get_face(final_font.path, current_font_size)
                
                # Step 1: Get glyphs, advances, and kerning
                glyphs = []
                previous_char_index = 0
                for char in text_to_render:
                    char_index = face.get_char_index(char)
                    face.load_glyph(char_index, freetype.FT_LOAD_NO_BITMAP)
                    
                    advance = face.glyph.metrics.horiAdvance / 64.0
                    kerning = 0
                    if previous_char_index != 0:
                        kerning_vec = face.get_kerning(previous_char_index, char_index)
                        kerning = kerning_vec.x / 64.0
                    
                    glyphs.append({'char': char, 'char_index': char_index, 'advance': advance, 'kerning': kerning})
                    previous_char_index = char_index
                
                # Step 2: Calculate total width and angle with letter spacing
                total_width = sum((g['advance'] + g['kerning']) * letter_spacing_factor for g in glyphs)
                total_angle_deg = (total_width / radius) * (180 / math.pi)

                # Step 3: Check if scaling is needed
                if max_angle_limit > 0 and total_angle_deg > max_angle_limit:
                    scale_ratio = max_angle_limit / total_angle_deg
                    new_font_size = max(8, int(current_font_size * scale_ratio))
                    
                    if new_font_size == current_font_size:
                        break # Avoid infinite loop if size doesn't change
                    
                    current_font_size = new_font_size
                    # We need to get a new PIL font object for the new size
                    # This requires finding the original font family name
                    font_family = "Arial" # Fallback
                    for name, info in self.font_map.items():
                        if info.get('path') == font.path:
                            font_family = name
                            break
                    
                    variable_settings = None
                    for el in self.text_elements:
                        if el.get('value') == original_text:
                            variable_settings = el.get('variableFontSettings')
                            break
                    final_font = self._get_pil_font(font_family, current_font_size, variable_settings)
                else:
                    break # Text fits, exit loop
            
            # --- Character Placement ---

            # Determine starting angle based on layout mode
            if layout_mode == 'centerAligned':
                placement_start_angle = (base_angle - total_angle_deg / 2) % 360
            else: # 'startAligned'
                placement_start_angle = base_angle

            current_angle_rad = math.radians(placement_start_angle)
            face = get_face(final_font.path, current_font_size) # Ensure we use the final size
            
            for g in glyphs:
                # Apply kerning first
                kerning_angle = (g['kerning'] * letter_spacing_factor) / radius
                current_angle_rad += kerning_angle
                
                # Calculate angle for this character's advance
                advance_angle = (g['advance'] * letter_spacing_factor) / radius
                
                # The center of the character's arc is where we place it
                center_char_angle_rad = current_angle_rad + (advance_angle / 2)
                
                # --- Drawing the character ---
                
                # Get glyph metrics for precise placement
                face.load_glyph(g['char_index'], freetype.FT_LOAD_DEFAULT)
                bitmap_left = face.glyph.bitmap_left
                bitmap_top = face.glyph.bitmap_top
                
                # Load glyph bitmap for drawing
                face.load_glyph(g['char_index'], freetype.FT_LOAD_RENDER)
                bitmap = face.glyph.bitmap
                
                if bitmap.width == 0 or bitmap.rows == 0:
                    # For spaces or empty glyphs, just advance the angle
                    current_angle_rad += advance_angle
                    continue
                
                # The point on the circle is the "pen position" (baseline origin) for this glyph
                origin_angle_rad = current_angle_rad
                origin_x = center_x + radius * math.cos(origin_angle_rad)
                origin_y = center_y + radius * math.sin(origin_angle_rad)

                # The rotation should be based on the character's center for best appearance
                rotation_rad = center_char_angle_rad + (math.pi / 2)
                if baseline_position == 'outside':
                    rotation_rad += math.pi
                rotation_deg = -math.degrees(rotation_rad)
                
                # Create a large temporary canvas to draw the glyph on, allowing for offsets
                ascent, descent = face.size.ascender / 64, face.size.descender / 64
                canvas_size = int((ascent - descent) * 2 + 20)
                canvas_center = canvas_size // 2
                
                temp_canvas = Image.new('RGBA', (canvas_size, canvas_size), (0,0,0,0))

                # Create the glyph image from the buffer
                glyph_array = np.array(bitmap.buffer, dtype=np.uint8).reshape((bitmap.rows, bitmap.width))
                char_img = Image.fromarray(glyph_array, mode='L')

                # Create a solid color image to use as the character color
                if len(color) == 3: glyph_color = color + (255,)
                else: glyph_color = color
                color_img = Image.new('RGBA', char_img.size, glyph_color)

                # Paste the colored glyph onto the temp canvas at the correct offset from the origin
                # The origin (pen position) is the center of our canvas.
                local_paste_x = canvas_center + bitmap_left
                local_paste_y = canvas_center - bitmap_top # Y is inverted in Pillow
                temp_canvas.paste(color_img, (local_paste_x, local_paste_y), char_img)

                # Rotate the entire canvas, which rotates the glyph around its baseline origin
                rotated_canvas = temp_canvas.rotate(rotation_deg, expand=False, resample=Image.BICUBIC)
                
                # Calculate the final paste position on the main image.
                # This aligns the center of our temp canvas (the glyph's origin) with the pen position on the circle.
                final_paste_x = int(origin_x - canvas_center)
                final_paste_y = int(origin_y - canvas_center)
                
                # Paste onto main image
                img.paste(rotated_canvas, (final_paste_x, final_paste_y), rotated_canvas)
                
                # Advance angle for the next character
                current_angle_rad += advance_angle
                
        except Exception as e:
            logger.error(f"Error drawing circular text with Freetype: {e}", exc_info=True)
            # Fallback to old method or simple drawing can be added here if needed
            logger.error("Freetype rendering failed. No fallback implemented.")

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
            
            # 获取字体基本度量信息
            metrics = face.size
            ascender = metrics.ascender / 64  # 转换为像素
            descender = metrics.descender / 64
            height = metrics.height / 64
            
            # 加载字体以获取字形映射
            tt = TTFont(font_path)
            glyph_set = tt.getGlyphOrder()
            glyph_name_to_index = {name: i for i, name in enumerate(glyph_set)}
            
            # 首先遍历一次计算总体尺寸和收集字形信息
            total_width = 0
            max_height = 0
            min_y = float('inf')
            max_y = float('-inf')
            glyph_positions = []
            
            # 第一遍：收集所有字形信息
            for i, char in enumerate(text):
                # 确定是否使用变体
                use_variant = False
                variant_index = None
                if i == 0 and first_variant is not None:
                    variant_index = first_variant
                    use_variant = True
                elif i == len(text) - 1 and last_variant is not None:
                    variant_index = last_variant
                    use_variant = True

                glyph_index = 0
                glyph_name = char # Default to base char

                # 只对字母和数字尝试查找变体
                if use_variant and char.isalnum():
                    # 获取变体字形名称
                    glyph_name = self._get_glyph_variant(char, variant_index, font_path)
                    # 获取字形索引
                    glyph_index = glyph_name_to_index.get(glyph_name, 0)
                    # 如果变体名称无效，回退到基本字符索引
                    if glyph_index == 0:
                         glyph_index = face.get_char_index(char)
                else:
                    # 对于空格、符号等，直接获取默认字形索引
                    glyph_index = face.get_char_index(char)

                # 加载字形，添加错误处理
                try:
                    # 先加载度量信息，不加载位图
                    face.load_glyph(glyph_index, freetype.FT_LOAD_RENDER | freetype.FT_LOAD_NO_BITMAP)
                    metrics = face.glyph.metrics
                    advance_x = metrics.horiAdvance / 64

                    # 再加载位图用于渲染
                    face.load_glyph(glyph_index, freetype.FT_LOAD_RENDER)
                    bitmap = face.glyph.bitmap
                    glyph_top = face.glyph.bitmap_top
                    glyph_bottom = glyph_top - bitmap.rows
                    min_y = min(min_y, glyph_bottom)
                    max_y = max(max_y, glyph_top)

                except freetype.ft_errors.FT_Exception as ft_error:
                    logger.warning(f"FreeType error loading glyph for char '{char}' (index {glyph_index}, name '{glyph_name}'): {ft_error}. Skipping character.")
                    advance_x = 0
                    # 尝试获取空格的默认宽度
                    if char == ' ':
                        try:
                            # 尝试加载默认空格度量
                            face.load_char(' ', freetype.FT_LOAD_DEFAULT | freetype.FT_LOAD_NO_BITMAP)
                            advance_x = face.glyph.metrics.horiAdvance / 64
                        except Exception:
                             # 如果失败，估算空格宽度
                             advance_x = font_size / 3
                             logger.warning(f"Could not load space metrics, estimating advance to {advance_x}")

                    # 存储占位符信息，只包含前进距离
                    glyph_positions.append({
                        'width': 0, 'height': 0, 'glyph_index': 0,
                        'advance_x': advance_x,
                        'bitmap_left': 0, 'bitmap_top': 0,
                        'bearing_x': 0, 'bearing_y': 0,
                        'is_placeholder': True # 标记为占位符
                    })
                    total_width += advance_x
                    continue # 继续处理下一个字符

                # 存储有效的字形信息
                glyph_positions.append({
                    'width': bitmap.width,
                    'height': bitmap.rows,
                    'glyph_index': glyph_index,
                    'advance_x': advance_x,
                    'bitmap_left': face.glyph.bitmap_left,
                    'bitmap_top': face.glyph.bitmap_top,
                    'bearing_x': metrics.horiBearingX / 64,
                    'bearing_y': metrics.horiBearingY / 64,
                    'is_placeholder': False
                })
                
                total_width += advance_x
            
            # 使用字体的实际高度
            actual_height = height
            
            # 确保图像高度足够容纳所有字形
            required_height = max_y - min_y
            img_height = max(actual_height, required_height)
           
            # 创建最终图像，添加额外的空间用于字形溢出
            extra_space = int(font_size * 0.2)  # 减少额外空间
            img_width = int(total_width + extra_space * 2)
            img_height = int(img_height + extra_space * 2)
            img = Image.new('RGBA', (img_width, img_height), (0, 0, 0, 0))
            
            # 计算基线位置
            # 基线位置应该在图像底部上方 |descender| 像素处
            baseline_y = img_height - extra_space + descender
            
            # 从左边的额外空间开始
            x_offset = extra_space
            
            # 第二遍：渲染字形
            for pos in glyph_positions:
                # 如果是占位符（加载失败的字形），只移动x偏移量
                if pos.get('is_placeholder', False):
                    x_offset += pos['advance_x']
                    continue

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
                    
                    # 垂直位置：从基线减去bitmap_top
                    y_pos = baseline_y - pos['bitmap_top']
                    
                    logger.debug(f"Placing glyph at x: {x_pos}, y: {y_pos}")
                    
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