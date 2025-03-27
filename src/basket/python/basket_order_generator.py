#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import json
import os
import base64
import tempfile
import traceback
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.text import PP_ALIGN
from pptx.dml.color import RGBColor

# Set constants for A4 landscape dimensions (in inches)
A4_WIDTH = 11.69  # 297mm
A4_HEIGHT = 8.27  # 210mm

def create_basket_order_slide(prs, order_data):
    """Create a slide for a basket order"""
    # Add a blank slide
    slide_layout = prs.slide_layouts[6]  # Blank layout
    slide = prs.slides.add_slide(slide_layout)
    
    # Set slide dimensions to A4 landscape
    prs.slide_width = Inches(A4_WIDTH)
    prs.slide_height = Inches(A4_HEIGHT)
    
    # Calculate margins and positions
    margin = Inches(0.5)
    
    # Add textboxes for each element
    # Date (制单日期)
    date_box = slide.shapes.add_textbox(margin, margin, Inches(3), Inches(0.5))
    date_text = date_box.text_frame
    date_p = date_text.paragraphs[0]
    date_p.text = order_data.get('date', '')
    date_p.font.bold = True
    date_p.font.size = Pt(24)
    
    # Order Number (订单号)
    order_box_x = margin + Inches(3.5)
    order_box = slide.shapes.add_textbox(order_box_x, margin, Inches(4), Inches(0.5))
    order_text = order_box.text_frame
    order_p = order_text.paragraphs[0]
    order_p.text = order_data.get('orderNumber', '')
    order_p.font.bold = True
    order_p.font.size = Pt(20)
    
    # Product (产品)
    product_box_x = order_box_x + Inches(4.5)
    product_box = slide.shapes.add_textbox(product_box_x, margin, Inches(2), Inches(0.5))
    product_text = product_box.text_frame
    product_p = product_text.paragraphs[0]
    product_p.text = order_data.get('product', '')
    product_p.font.bold = True
    product_p.font.size = Pt(20)
    
    # Color (毛线颜色)
    color_box = slide.shapes.add_textbox(order_box_x + Inches(2.5), margin + Inches(0.6), Inches(2), Inches(0.5))
    color_text = color_box.text_frame
    color_p = color_text.paragraphs[0]
    color_p.text = order_data.get('color', '')
    color_p.font.bold = True
    color_p.font.size = Pt(20)
    
    # Icon (图标)
    icon_box = slide.shapes.add_textbox(order_box_x + Inches(5), margin + Inches(0.6), Inches(2), Inches(0.5))
    icon_text = icon_box.text_frame
    icon_p = icon_text.paragraphs[0]
    icon_p.text = order_data.get('icon', '')
    icon_p.font.bold = True
    icon_p.font.size = Pt(20)
    
    # Order position (一单多买的序号)
    position_box = slide.shapes.add_textbox(prs.slide_width - margin - Inches(1.5), margin, Inches(1.5), Inches(0.5))
    position_text = position_box.text_frame
    position_p = position_text.paragraphs[0]
    position_p.text = order_data.get('position', '')
    position_p.alignment = PP_ALIGN.RIGHT
    position_p.font.bold = True
    position_p.font.size = Pt(20)
    
    # Recipient Name (收件人姓名)
    name_box = slide.shapes.add_textbox(margin, margin + Inches(2), prs.slide_width - margin * 2, Inches(3))
    name_text = name_box.text_frame
    name_p = name_text.paragraphs[0]
    name_p.text = order_data.get('recipientName', '')
    name_p.alignment = PP_ALIGN.CENTER
    name_p.font.bold = True
    name_p.font.size = Pt(96)
    
    # Custom Name (定制名字)
    custom_name_box = slide.shapes.add_textbox(margin, margin + Inches(5), prs.slide_width - margin * 2, Inches(2))
    custom_text = custom_name_box.text_frame
    custom_p = custom_text.paragraphs[0]
    custom_p.text = order_data.get('customName', '')
    custom_p.alignment = PP_ALIGN.CENTER
    custom_p.font.bold = True
    custom_p.font.size = Pt(72)
    
    # Return the slide
    return slide

def process_json_data(orders_data):
    """Process JSON data and generate PPT slides"""
    try:
        # Create a new presentation
        prs = Presentation()
        
        # Create slides for each order in the data
        slides_created = 0
        errors = []
        
        for index, order_data in enumerate(orders_data):
            try:
                # Create slide for this order
                create_basket_order_slide(prs, order_data)
                slides_created += 1
            except Exception as e:
                errors.append(f"Error processing order {index + 1}: {str(e)}")
        
        # Save the presentation to a temporary file
        output_path = os.path.join(tempfile.gettempdir(), 'basket_orders.pptx')
        prs.save(output_path)
        
        # Read the file and encode it as base64
        with open(output_path, 'rb') as file:
            ppt_data = base64.b64encode(file.read()).decode('utf-8')
        
        # Clean up temporary file
        os.unlink(output_path)
        
        # Return success result with the PPT data
        result = {
            'success': True,
            'message': f'Successfully generated {slides_created} slides',
            'slides_created': slides_created,
            'data': ppt_data,
            'errors': errors if errors else None
        }
        
    except Exception as e:
        # Return error result
        result = {
            'success': False,
            'message': f'Error generating PPT: {str(e)}',
            'error': traceback.format_exc()
        }
    
    return result

def main():
    """Main function to handle command line input and output"""
    try:
        # Read JSON input from stdin
        input_data = json.loads(sys.stdin.read())
        json_data = input_data.get('excelData')
        
        if not json_data:
            result = {
                'success': False,
                'message': 'No data provided'
            }
        else:
            # Decode base64 data if provided
            try:
                decoded_data = base64.b64decode(json_data).decode('utf-8')
                orders_data = json.loads(decoded_data)
                result = process_json_data(orders_data)
            except Exception as e:
                result = {
                    'success': False,
                    'message': f'Error decoding or parsing data: {str(e)}',
                    'error': traceback.format_exc()
                }
        
        # Output the result as JSON
        print(json.dumps(result))
        
    except Exception as e:
        # Return error result if there's an exception
        result = {
            'success': False,
            'message': f'Error: {str(e)}',
            'error': traceback.format_exc()
        }
        print(json.dumps(result))

if __name__ == '__main__':
    main() 