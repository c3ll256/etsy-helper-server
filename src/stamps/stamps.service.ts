import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createCanvas, loadImage, registerFont, Canvas, CanvasRenderingContext2D } from 'canvas';
import * as fs from 'fs';
import * as path from 'path';

import { StampTemplate, TextElement } from './entities/stamp-template.entity';
import { CreateStampTemplateDto } from './dto/create-stamp-template.dto';
import { GenerateStampDto } from './dto/generate-stamp.dto';
import { PreviewStampDto } from './dto/preview-stamp.dto';
import { CloneStampTemplateDto } from './dto/clone-stamp-template.dto';

@Injectable()
export class StampsService {
  constructor(
    @InjectRepository(StampTemplate)
    private stampTemplateRepository: Repository<StampTemplate>,
  ) {
    // Register fonts that will be available for stamp generation
    this.registerAvailableFonts();
  }

  private registerAvailableFonts() {
    const fontsDir = path.join(process.cwd(), 'uploads', 'fonts');
    
    // Create fonts directory if it doesn't exist
    if (!fs.existsSync(fontsDir)) {
      fs.mkdirSync(fontsDir, { recursive: true });
      console.log('Created fonts directory at:', fontsDir);
      return;
    }
    
    try {
      const fontFiles = fs.readdirSync(fontsDir);
      console.log(`Found ${fontFiles.length} font files in ${fontsDir}`);
      
      fontFiles.forEach(file => {
        const fontPath = path.join(fontsDir, file);
        // Skip directories
        if (fs.statSync(fontPath).isDirectory()) return;
        
        const fontFamily = path.basename(file, path.extname(file));
        
        try {
          // Register the font with its exact name
          registerFont(fontPath, { family: fontFamily });
          console.log(`Registered font: ${fontFamily} from ${fontPath}`);
          
          // Also register without hyphens if the name contains them
          if (fontFamily.includes('-')) {
            const noHyphenName = fontFamily.replace(/-/g, '');
            registerFont(fontPath, { family: noHyphenName });
            console.log(`Also registered as: ${noHyphenName} (without hyphens)`);
          }
        } catch (error) {
          console.error(`Failed to register font ${fontFamily}:`, error);
        }
      });
    } catch (error) {
      console.error(`Error registering fonts from ${fontsDir}:`, error);
    }
  }

  async create(createStampTemplateDto: CreateStampTemplateDto): Promise<StampTemplate> {
    const template = this.stampTemplateRepository.create(createStampTemplateDto);
    return this.stampTemplateRepository.save(template);
  }

  async findAll(): Promise<StampTemplate[]> {
    return this.stampTemplateRepository.find();
  }

  async findById(id: number): Promise<StampTemplate> {
    let template: StampTemplate;

    template = await this.stampTemplateRepository.findOne({ where: { id } });

    if (!template) {
      throw new NotFoundException(`Stamp template with ID or SKU ${id} not found`);
    }
    
    return template;
  }

  async remove(id: number): Promise<void> {
    const result = await this.stampTemplateRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`Stamp template with ID ${id} not found`);
    }
  }

  async generateStamp(generateStampDto: GenerateStampDto): Promise<Buffer> {
    const { templateId, textElements, format = 'png', quality = 0.9 } = generateStampDto;
    
    // Find the template
    const template = await this.findById(templateId);
    
    try {
      // Create canvas with the template's dimensions
      const canvas = createCanvas(template.width, template.height);
      const ctx = canvas.getContext('2d');
      
      // Check if the template has a background image
      if (template.backgroundImagePath) {
        // Load the background image
        const backgroundImagePath = path.join(process.cwd(), template.backgroundImagePath);
        if (!fs.existsSync(backgroundImagePath)) {
          throw new NotFoundException(`Background image not found at ${backgroundImagePath}`);
        }
        
        const backgroundImage = await loadImage(backgroundImagePath);
        
        // Draw background image, scaling it to fit the canvas if needed
        ctx.drawImage(backgroundImage, 0, 0, template.width, template.height);
      } else {
        // Set white background instead of transparent
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, template.width, template.height);
      }
      
      // Process text elements
      await this.drawTextElements(ctx, template.textElements, textElements);
      
      // Convert to buffer
      return this.canvasToBuffer(canvas, format, quality);
    } catch (error) {
      console.error('Error generating stamp:', error);
      throw new BadRequestException(`Failed to generate stamp: ${error.message}`);
    }
  }

  private async drawTextElements(
    ctx: CanvasRenderingContext2D, 
    templateElements: TextElement[], 
    inputElements: GenerateStampDto['textElements']
  ): Promise<void> {
    // Create a map of input elements by ID for easy lookup
    const inputElementsMap = new Map(
      inputElements.map(element => [element.id, element])
    );
    
    // Process each template element
    for (const templateElement of templateElements) {
      const inputElement = inputElementsMap.get(templateElement.id);
      
      // Skip if no input provided for this element
      if (!inputElement) continue;
      
      // Get the text value (use input value or template default)
      const text = inputElement.value || templateElement.defaultValue;
      
      // Skip if no text to render
      if (!text) continue;
      
      // Merge template position with any overrides from input
      const position = {
        ...templateElement.position,
        ...(inputElement.position || {}),
      };
      
      // Get font properties
      const fontFamily = templateElement.fontFamily;
      const fontSize = templateElement.fontSize;
      
      // Set the font - use the exact font name with quotes
      ctx.font = `${fontSize}px "${fontFamily}"`;
      console.log(`Setting font: ${ctx.font} for text: ${text}`);
      
      // Set fill style
      ctx.fillStyle = templateElement.color || '#000000';
      
      // Set text alignment
      ctx.textAlign = position.textAlign || 'left';
      
      // Save context state before transformations
      ctx.save();
      
      // Apply rotation if specified
      if (position.rotation) {
        // Rotate around the text position point
        ctx.translate(position.x, position.y);
        ctx.rotate((position.rotation * Math.PI) / 180);
        ctx.translate(-position.x, -position.y);
      }
      
      // Draw the text
      ctx.fillText(text, position.x, position.y);
      
      // Restore context state
      ctx.restore();
    }
  }

  private canvasToBuffer(canvas: Canvas, format: string, quality: number): Buffer {
    switch (format) {
      case 'jpeg':
        return canvas.toBuffer();
      case 'webp':
        return canvas.toBuffer(); // Using default format since webp might not be supported
      case 'png':
      default:
        return canvas.toBuffer();
    }
  }

  async previewStamp(previewStampDto: PreviewStampDto): Promise<Buffer> {
    const { 
      templateId, 
      textElements, 
      width = 500, 
      height = 500, 
      backgroundImagePath, 
      format = 'png', 
      quality = 0.9 
    } = previewStampDto;
    
    let template: StampTemplate | null = null;
    
    // If templateId is provided, try to find the template
    if (templateId) {
      try {
        template = await this.findById(templateId);
      } catch (error) {
        // If template not found, we'll create a temporary one from the provided data
        console.log(`Template with ID ${templateId} not found, using provided data instead`);
      }
    }
    
    try {
      // Create canvas with the specified dimensions or from template
      const canvasWidth = template?.width || width;
      const canvasHeight = template?.height || height;
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');
      
      // Check if there's a background image to use
      const bgImagePath = template?.backgroundImagePath || backgroundImagePath;
      
      if (bgImagePath) {
        // Load the background image
        const fullBgImagePath = path.join(process.cwd(), bgImagePath);
        if (fs.existsSync(fullBgImagePath)) {
          const backgroundImage = await loadImage(fullBgImagePath);
          // Draw background image, scaling it to fit the canvas if needed
          ctx.drawImage(backgroundImage, 0, 0, canvasWidth, canvasHeight);
        } else {
          // Set white background if image not found
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, canvasWidth, canvasHeight);
          console.warn(`Background image not found at ${fullBgImagePath}`);
        }
      } else {
        // Set white background instead of transparent
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      }
      
      // Process text elements
      await this.drawPreviewTextElements(ctx, template?.textElements || [], textElements);
      
      // Convert to buffer
      return this.canvasToBuffer(canvas, format, quality);
    } catch (error) {
      console.error('Error generating preview stamp:', error);
      throw new BadRequestException(`Failed to generate preview stamp: ${error.message}`);
    }
  }
  
  private async drawPreviewTextElements(
    ctx: CanvasRenderingContext2D, 
    templateElements: TextElement[], 
    previewElements: PreviewStampDto['textElements']
  ): Promise<void> {
    // Create a map of template elements by ID for quick lookup
    const templateElementsMap = new Map<string, TextElement>();
    templateElements.forEach(element => {
      templateElementsMap.set(element.id, element);
    });
    
    // Process each preview element
    for (const previewElement of previewElements) {
      // Get the template element if it exists
      const templateElement = templateElementsMap.get(previewElement.id);
      
      // Merge template and preview properties
      const fontFamily = previewElement.fontFamily || templateElement?.fontFamily || 'Arial';
      const fontSize = previewElement.fontSize || templateElement?.fontSize || 16;
      const fontWeight = previewElement.fontWeight || templateElement?.fontWeight || 'normal';
      const fontStyle = previewElement.fontStyle || templateElement?.fontStyle || 'normal';
      const color = previewElement.color || templateElement?.color || 'black';
      
      // Set font properties
      ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
      ctx.fillStyle = color;
      
      // Get position information
      const position = previewElement.position || templateElement?.position || { x: 10, y: 10 };
      const { x, y, width, height, rotation = 0, textAlign = 'left' } = position;
      
      // Set text alignment
      ctx.textAlign = textAlign as CanvasTextAlign;
      
      // Apply rotation if specified
      if (rotation !== 0) {
        ctx.save();
        // Rotate around the text position
        ctx.translate(x, y);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.translate(-x, -y);
      }
      
      // Draw the text
      const text = previewElement.value || templateElement?.defaultValue || '';
      
      if (width) {
        // If width is specified, wrap text to fit
        this.wrapText(ctx, text, x, y, width, fontSize * 1.2);
      } else {
        // Otherwise, draw text normally
        ctx.fillText(text, x, y);
      }
      
      // Restore canvas state if rotation was applied
      if (rotation !== 0) {
        ctx.restore();
      }
    }
  }
  
  // Helper method to wrap text within a specified width
  private wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number
  ): void {
    const words = text.split(' ');
    let line = '';
    let testLine = '';
    let lineCount = 0;
    
    for (let n = 0; n < words.length; n++) {
      testLine = line + words[n] + ' ';
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;
      
      if (testWidth > maxWidth && n > 0) {
        ctx.fillText(line, x, y + lineCount * lineHeight);
        line = words[n] + ' ';
        lineCount++;
      } else {
        line = testLine;
      }
    }
    
    ctx.fillText(line, x, y + lineCount * lineHeight);
  }

  async cloneTemplate(cloneStampTemplateDto: CloneStampTemplateDto): Promise<StampTemplate> {
    const { sourceTemplateId, newName, newSku } = cloneStampTemplateDto;
    
    // 查找源模板
    const sourceTemplate = await this.findById(sourceTemplateId);
    
    // 创建新模板对象，复制源模板的所有属性
    const clonedTemplate = new StampTemplate();
    
    // 复制基本属性
    clonedTemplate.width = sourceTemplate.width;
    clonedTemplate.height = sourceTemplate.height;
    clonedTemplate.backgroundImagePath = sourceTemplate.backgroundImagePath;
    clonedTemplate.description = sourceTemplate.description;
    clonedTemplate.isActive = sourceTemplate.isActive;
    
    // 设置新名称，如果没有提供则使用默认格式
    clonedTemplate.name = newName || `复制 - ${sourceTemplate.name}`;
    
    // 设置新SKU，如果没有提供则生成一个唯一的SKU
    if (newSku) {
      // 检查SKU是否已存在
      const existingTemplate = await this.stampTemplateRepository.findOne({ where: { sku: newSku } });
      if (existingTemplate) {
        throw new BadRequestException(`SKU "${newSku}" 已存在，请使用其他SKU`);
      }
      clonedTemplate.sku = newSku;
    } else {
      // 生成一个基于时间戳的唯一SKU
      const timestamp = new Date().getTime();
      clonedTemplate.sku = `${sourceTemplate.sku}-copy-${timestamp}`;
    }
    
    // 深度复制文本元素数组
    if (sourceTemplate.textElements && sourceTemplate.textElements.length > 0) {
      clonedTemplate.textElements = JSON.parse(JSON.stringify(sourceTemplate.textElements));
    } else {
      clonedTemplate.textElements = [];
    }
    
    // 保存新模板
    return this.stampTemplateRepository.save(clonedTemplate);
  }
} 