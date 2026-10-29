import * as path from 'path';
import { FontToolsService } from './font-tools.service';
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
    private readonly fontToolsService: FontToolsService,
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

  async findAll(): Promise<Array<Font & { fileMissing: boolean }>> {
    const fonts = await this.fontRepository.find({
      order: {
        createdAt: 'DESC',
      },
    });
    // 文件已丢失的字体单独标出：生成时会报"字体缺失"，需要用"更换文件"补上
    return fonts.map(font => ({ ...font, fileMissing: !font.filePath || !fs.existsSync(font.filePath) }));
  }

  async assertNameAvailable(name: string): Promise<void> {
    const existing = await this.fontRepository.findOne({ where: { name } });
    if (existing) {
      throw new BadRequestException(`字体名称「${name}」已存在。要替换它的文件请在字体列表里点"更换文件"，模板会自动使用新文件`);
    }
  }

  /** TTC / OTC 字体集合：拆成单个字体分别建记录；第一个用填写的名称，其余为"名称-样式名" */
  async createFromCollection(file: Express.Multer.File, name: string, description?: string): Promise<Font[]> {
    const prefix = path.basename(file.filename, path.extname(file.filename));
    let faces;
    try {
      faces = await this.fontToolsService.splitCollection(file.path, path.dirname(file.path), prefix);
    } catch (error) {
      throw new BadRequestException(`字体集合拆分失败：${error.message}`);
    } finally {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }

    const created: Font[] = [];
    for (const face of faces) {
      const faceName = face.index === 0 ? name : `${name}-${face.subfamily || face.index}`;
      const exists = await this.fontRepository.findOne({ where: { name: faceName } });
      const finalName = exists ? `${faceName}-${face.index}` : faceName;
      const font = new Font();
      font.name = finalName;
      font.filename = face.filename;
      font.filePath = path.join(path.dirname(file.path), face.filename);
      font.fontWeight = (face.subfamily || 'regular').toLowerCase();
      font.description = [description, `来自字体集合 ${file.originalname} 第 ${(face.index ?? 0) + 1} 个字体（${face.fullName || face.family || ''}）`]
        .filter(Boolean)
        .join('；');
      created.push(await this.fontRepository.save(font));
    }
    return created;
  }

  /** 更换字体文件，名称不变；旧文件保留在磁盘上不删除 */
  async replaceFile(id: number, file: Express.Multer.File): Promise<Font> {
    const font = await this.findOne(id);
    font.filename = file.filename;
    font.filePath = file.path;
    return this.fontRepository.save(font);
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
