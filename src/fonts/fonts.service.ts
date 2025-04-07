import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';

import { Font } from './entities/font.entity';
import { CreateFontDto } from './dto/create-font.dto';
import { StampTemplate } from '../stamps/entities/stamp-template.entity';

@Injectable()
export class FontsService {
  constructor(
    @InjectRepository(Font)
    private fontRepository: Repository<Font>,
    @InjectRepository(StampTemplate)
    private stampTemplateRepository: Repository<StampTemplate>,
  ) {}

  async create(createFontDto: CreateFontDto, file: Express.Multer.File): Promise<Font> {
    const font = new Font();
    font.name = createFontDto.name;
    font.filename = file.filename;
    font.filePath = file.path;
    
    if (createFontDto.fontWeight) {
      font.fontWeight = createFontDto.fontWeight;
    }
    
    if (createFontDto.isVariableFont !== undefined) {
      font.isVariableFont = createFontDto.isVariableFont;
    }
    
    if (createFontDto.description) {
      font.description = createFontDto.description;
    }
    
    return this.fontRepository.save(font);
  }

  async findAll(): Promise<Font[]> {
    return this.fontRepository.find({
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async findAllByStatus(isActive: boolean): Promise<Font[]> {
    return this.fontRepository.find({
      where: { isActive },
      order: {
        name: 'ASC',
      },
    });
  }

  async findOne(id: number): Promise<Font> {
    const font = await this.fontRepository.findOne({ where: { id } });
    if (!font) {
      throw new NotFoundException(`Font with ID ${id} not found`);
    }
    return font;
  }

  async isFontUsedByTemplates(fontId: number): Promise<{ isUsed: boolean; templateCount: number }> {
    const font = await this.findOne(fontId);
    
    // Find all templates that use this font
    const templates = await this.stampTemplateRepository.find();
    
    let usageCount = 0;
    
    // Check each template to see if it uses this font
    for (const template of templates) {
      if (template.textElements && Array.isArray(template.textElements)) {
        for (const element of template.textElements) {
          if (element.fontFamily === font.name) {
            usageCount++;
            break; // Only count each template once
          }
        }
      }
    }
    
    return {
      isUsed: usageCount > 0,
      templateCount: usageCount,
    };
  }

  async remove(id: number): Promise<void> {
    const font = await this.findOne(id);
    
    // Check if font is being used by any templates
    const { isUsed, templateCount } = await this.isFontUsedByTemplates(id);
    
    if (isUsed) {
      throw new BadRequestException(`Cannot delete font that is being used by ${templateCount} templates. Please update the templates to use a different font first.`);
    }
    
    // Delete the physical file
    try {
      fs.unlinkSync(font.filePath);
    } catch (error) {
      console.error(`Failed to delete font file: ${font.filePath}`, error);
      // Continue with the deletion of the DB record even if file delete fails
    }
    
    await this.fontRepository.remove(font);
  }

  async updateStatus(id: number, isActive: boolean): Promise<Font> {
    const font = await this.findOne(id);
    font.isActive = isActive;
    return this.fontRepository.save(font);
  }
} 