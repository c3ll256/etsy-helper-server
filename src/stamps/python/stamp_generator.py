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
        
        return font_map

    def _get_font_path(self, font_family):
        """Get the font file path for a given font family"""
        if font_family in self.font_map:
            return self.font_map[font_family]
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
                
                # Load font
                font_path = self._get_font_path(font_family)
                if not font_path or not os.path.exists(font_path):
                    # 返回 None 和错误信息，而不是打印
                    return None, f"Font not found: {font_family}"
                
                font = ImageFont.truetype(font_path, size=font_size)
                
                # Draw text
                draw.text((x, y), text, fill=color, font=font)
                
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
                                # Add a comment to indicate the background source
                                bg_group.add(dwg.desc(f"Background from {self.background_image_path}"))
                                # Note: In a production implementation, you'd parse the SVG properly
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
                
                if self.convert_text_to_paths:
                    # Convert text to path
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
        return dwg.tostring(), None
    
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
            
            # Create a group for the text
            text_group = dwg.g(fill=color)
            
            # Apply rotation if specified
            if rotation:
                text_group['transform'] = f"rotate({rotation} {x} {y})"
            
            # Calculate text width for alignment
            total_width = 0
            cmap = font['cmap'].getBestCmap()
            
            for char in text:
                if ord(char) in cmap:
                    glyph_name = cmap[ord(char)]
                    glyph = glyph_set[glyph_name]
                    width = glyph.width * font_size / font['head'].unitsPerEm
                    total_width += width
            
            # Calculate starting position based on alignment
            start_x = x
            if text_align == 'center':
                start_x = x - (total_width / 2)
            elif text_align == 'right':
                start_x = x - total_width
            
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
                        # Scale and position the path
                        scale_factor = font_size / font['head'].unitsPerEm
                        
                        # Create path element
                        path = dwg.path(d=path_data)
                        
                        # Apply scaling and positioning transformation
                        transform = f"translate({current_x}, {y}) scale({scale_factor}, -{scale_factor})"
                        path['transform'] = transform
                        
                        # Add path to group
                        text_group.add(path)
                    
                    # Advance to next character position
                    width = glyph.width * font_size / font['head'].unitsPerEm
                    current_x += width
            
            # Add the text group to the drawing
            dwg.add(text_group)
            return None
            
        except Exception as e:
            return f"Error converting text to path: {e}"

    def generate(self):
        """Generate the stamp in the specified format"""
        if self.format == 'svg':
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
                encoded_data = base64.b64encode(data).decode('utf-8')
                print(json.dumps({'success': True, 'data': encoded_data}))
                
    except Exception as e:
        # Return error as JSON
        print(json.dumps({'success': False, 'error': str(e)}))

if __name__ == "__main__":
    main() 