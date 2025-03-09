import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createCanvas, loadImage, registerFont, Canvas, CanvasRenderingContext2D } from 'canvas';
import * as fs from 'fs';
import * as path from 'path';

import { StampTemplate, TextElement } from './entities/stamp-template.entity';
import { CreateStampTemplateDto } from './dto/create-stamp-template.dto';
import { GenerateStampDto } from './dto/generate-stamp.dto';

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
      
      fontFiles.forEach(file => {
        const fontPath = path.join(fontsDir, file);
        // Skip directories
        if (fs.statSync(fontPath).isDirectory()) return;
        
        const fontFamily = path.basename(file, path.extname(file));
        
        try {
          registerFont(fontPath, { family: fontFamily });
          console.log(`Registered font: ${fontFamily} from ${fontPath}`);
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
        // Set transparent background (optional, as canvas is transparent by default)
        ctx.clearRect(0, 0, template.width, template.height);
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
      
      // Set text properties
      ctx.font = `${templateElement.fontStyle || ''} ${templateElement.fontWeight || ''} ${templateElement.fontSize}px "${templateElement.fontFamily}"`;
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
} 