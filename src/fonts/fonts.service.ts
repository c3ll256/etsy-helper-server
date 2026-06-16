import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';

import { Font } from './entities/font.entity';
import { CreateFontDto } from './dto/create-font.dto';
import { StampTemplate } from '../stamps/entities/stamp-template.entity';

export interface FontTemplateUsage {
  id: number;
  name: string;
  type: string;
}

export interface FontUsageResult {
  isUsed: boolean;
  templateCount: number;
  templates: FontTemplateUsage[];
}

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

  private async getTemplatesUsingFont(font: Font): Promise<FontTemplateUsage[]> {
    const templates = await this.stampTemplateRepository.find();

    return templates
      .filter((template) =>
        Array.isArray(template.textElements) &&
        template.textElements.some((element) => element.fontFamily === font.name),
      )
      .map((template) => ({
        id: template.id,
        name: template.name,
        type: template.type,
      }));
  }

  private formatTemplateUsageMessage(templates: FontTemplateUsage[]): string {
    return templates
      .map((template) => `#${template.id} ${template.name} (${template.type})`)
      .join('、');
  }

  private async assertFontCanBeModified(fontId: number, action: 'delete' | 'disable'): Promise<Font> {
    const font = await this.findOne(fontId);
    const templates = await this.getTemplatesUsingFont(font);

    if (templates.length === 0) {
      return font;
    }

    const actionText = action === 'delete' ? '删除' : '停用';
    const templateList = this.formatTemplateUsageMessage(templates);

    throw new BadRequestException(
      `无法${actionText}字体“${font.name}”。该字体正在被 ${templates.length} 个印章模板使用：${templateList}。请先将这些模板改为其他字体后再重试。`,
    );
  }

  async isFontUsedByTemplates(fontId: number): Promise<FontUsageResult> {
    const font = await this.findOne(fontId);
    const templates = await this.getTemplatesUsingFont(font);

    return {
      isUsed: templates.length > 0,
      templateCount: templates.length,
      templates,
    };
  }

  async remove(id: number): Promise<void> {
    const font = await this.assertFontCanBeModified(id, 'delete');

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

    if (!isActive) {
      await this.assertFontCanBeModified(id, 'disable');
    }

    font.isActive = isActive;
    return this.fontRepository.save(font);
  }
}
