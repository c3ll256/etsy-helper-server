import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, ILike, In } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';

import { StampTemplate, StampType } from './entities/stamp-template.entity';
import { StampGenerationRecord } from './entities/stamp-generation-record.entity';
import { CreateStampTemplateDto } from './dto/create-stamp-template.dto';
import { CloneStampTemplateDto } from './dto/clone-stamp-template.dto';
import { UpdateStampTemplateDto } from './dto/update-stamp-template.dto';
import { PythonStampService } from './services/python-stamp.service';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';

@Injectable()
export class StampsService {
  constructor(
    @InjectRepository(StampTemplate)
    private stampTemplateRepository: Repository<StampTemplate>,
    @InjectRepository(StampGenerationRecord)
    private stampGenerationRecordRepository: Repository<StampGenerationRecord>,
    private readonly pythonStampService: PythonStampService
  ) {
  }

  private async generateAndSavePreview(template: StampTemplate): Promise<string> {
    if (!template || !template.id || !template.textElements) {
      console.error('Cannot generate preview: Template data is incomplete', template);
      throw new Error('Template data is incomplete for preview generation.');
    }

    const previewDir = path.join(process.cwd(), 'uploads', 'previews');
    if (!fs.existsSync(previewDir)) {
      fs.mkdirSync(previewDir, { recursive: true });
    }

    const previewFileName = `preview-${template.id}-${Date.now()}.png`;
    const previewPath = path.join(previewDir, previewFileName);

    const elementsForPreview = template.textElements.map(el => ({ 
        ...el, 
        value: el.defaultValue 
    }));

    const buffer = await this.pythonStampService.generateStamp({
      template,
      textElements: elementsForPreview,
      convertTextToPaths: false
    });

    fs.writeFileSync(previewPath, buffer);
    return `uploads/previews/${previewFileName}`;
  }

  async create(
    createStampTemplateDto: CreateStampTemplateDto,
    user: User
  ): Promise<StampTemplate> {
    const existingSku = await this.stampTemplateRepository.findOne({ where: { sku: createStampTemplateDto.sku } });
    if (existingSku) {
        throw new BadRequestException(`SKU "${createStampTemplateDto.sku}" already exists.`);
    }

    const templateData: Partial<StampTemplate> = {
        ...createStampTemplateDto,
        userId: user.id as string,
    };
    
    const templateEntity = this.stampTemplateRepository.create(templateData);
    let savedTemplate = await this.stampTemplateRepository.save(templateEntity); 

    try {
        const previewPath = await this.generateAndSavePreview(savedTemplate);
        savedTemplate.previewImagePath = previewPath;
        savedTemplate = await this.stampTemplateRepository.save(savedTemplate); 
    } catch (previewError) {
        console.error(`Failed to generate preview for new template ${savedTemplate.id}:`, previewError);
    }
    return savedTemplate;
  }

  async findAll(
      paginationDto: PaginationDto,
      user: User,
      search?: string,
      type?: StampType,
  ): Promise<PaginatedResponse<StampTemplate>> {
    const { page = 1, limit = 10 } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.stampTemplateRepository.createQueryBuilder('template');

    if (!user.isAdmin) {
      queryBuilder.andWhere('template.userId = :userId', { userId: user.id as string });
    }

    if (type) {
      queryBuilder.andWhere('template.type = :type', { type });
    }

    if (search) {
        queryBuilder.andWhere('(LOWER(template.name) LIKE LOWER(:search) OR LOWER(template.sku) LIKE LOWER(:search))', {
            search: `%${search}%`,
        });
    }

    queryBuilder
      .leftJoinAndSelect('template.user', 'user')
      .select([
          'template.id', 'template.sku', 'template.name', 'template.backgroundImagePath', 
          'template.width', 'template.height', 'template.textElements', 'template.description',
          'template.type', 'template.previewImagePath', 'template.isActive', 'template.createdAt',
          'template.updatedAt', 'template.userId',
          'user.id', 'user.username'
      ]) 
      .orderBy('template.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    const [results, total] = await queryBuilder.getManyAndCount();

    const response: PaginatedResponse<StampTemplate> = {
      items: results,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      }
    };
    return response;
  }

  async findById(id: number, user: User): Promise<StampTemplate> {
    const template = await this.stampTemplateRepository.findOne({ 
        where: { id },
        relations: ['user']
    });

    if (!template) {
      throw new NotFoundException(`Stamp template with ID ${id} not found`);
    }

    if (!user.isAdmin && template.userId !== user.id) {
      throw new ForbiddenException('You do not have permission to access this template');
    }
    
    return template;
  }

  async remove(id: number, user: User): Promise<void> {
    const template = await this.findById(id, user);
    
    const result = await this.stampTemplateRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`Stamp template with ID ${id} not found or could not be deleted`);
    }
  }

  async cloneTemplate(
    cloneStampTemplateDto: CloneStampTemplateDto, 
    user: User
  ): Promise<StampTemplate> {
    const { sourceTemplateId, newName, newSku } = cloneStampTemplateDto;
    const sourceTemplate = await this.findById(sourceTemplateId, user);
    
    let finalSku = newSku;
    if (!finalSku) {
        const timestamp = new Date().getTime();
        finalSku = `${sourceTemplate.sku}-copy-${timestamp}`;
    }

    const existingTemplate = await this.stampTemplateRepository.findOne({ where: { sku: finalSku } });
    if (existingTemplate) {
      throw new BadRequestException(`SKU "${finalSku}" already exists. Please choose a different SKU.`);
    }

    const clonedTemplateData: Partial<StampTemplate> = {
        sku: finalSku,
        name: newName || `复制 - ${sourceTemplate.name}`,
        backgroundImagePath: sourceTemplate.backgroundImagePath,
        width: sourceTemplate.width,
        height: sourceTemplate.height,
        textElements: sourceTemplate.textElements ? JSON.parse(JSON.stringify(sourceTemplate.textElements)) : [], 
        description: sourceTemplate.description,
        type: sourceTemplate.type,
        isActive: sourceTemplate.isActive,
        userId: user.id as string,
    };

    const clonedEntity = this.stampTemplateRepository.create(clonedTemplateData);
    let savedClonedTemplate = await this.stampTemplateRepository.save(clonedEntity);
    
    try {
        const previewPath = await this.generateAndSavePreview(savedClonedTemplate);
        savedClonedTemplate.previewImagePath = previewPath;
        savedClonedTemplate = await this.stampTemplateRepository.save(savedClonedTemplate);
    } catch (previewError) {
        console.error(`Failed to generate preview for cloned template ${savedClonedTemplate.id}:`, previewError);
    }
    return savedClonedTemplate;
  }

  async createGenerationRecord(
    orderId: string, 
    templateId: number, 
    textElements: any[], 
    stampImageUrl: string
  ): Promise<StampGenerationRecord> {
    const record = this.stampGenerationRecordRepository.create({
      orderId,
      templateId,
      textElements,
      stampImageUrl
    });
    
    return await this.stampGenerationRecordRepository.save(record);
  }

  async getGenerationRecordsByOrderId(orderId: string): Promise<StampGenerationRecord[]> {
    return this.stampGenerationRecordRepository.find({
      where: { orderId },
      order: { createdAt: 'DESC' },
      relations: ['template']
    });
  }

  async getGenerationRecordById(id: number): Promise<StampGenerationRecord> {
    const record = await this.stampGenerationRecordRepository.findOne({
      where: { id },
      relations: ['template']
    });
    
    if (!record) {
      throw new NotFoundException(`Stamp generation record with ID ${id} not found`);
    }
    
    return record;
  }

  async getLatestGenerationRecord(): Promise<StampGenerationRecord | null> {
    return this.stampGenerationRecordRepository.findOne({
      order: { createdAt: 'DESC' },
      relations: ['template']
    });
  }

  async getLatestGenerationRecordByOrderId(orderId: string): Promise<StampGenerationRecord | null> {
    return this.stampGenerationRecordRepository.findOne({
      where: { orderId },
      order: { createdAt: 'DESC' },
      relations: ['template']
    });
  }

  async update(
    id: number, 
    updateStampTemplateDto: UpdateStampTemplateDto, 
    user: User
  ): Promise<StampTemplate> {
    let template = await this.findById(id, user);
    
    if (updateStampTemplateDto.sku && updateStampTemplateDto.sku !== template.sku) {
      const existingTemplate = await this.stampTemplateRepository.findOne({ 
        where: { sku: updateStampTemplateDto.sku }
      });
      
      if (existingTemplate && existingTemplate.id !== id) {
        throw new BadRequestException(`Another template with SKU "${updateStampTemplateDto.sku}" already exists.`);
      }
    }
    
    template = this.stampTemplateRepository.merge(template, updateStampTemplateDto);
    let savedTemplate = await this.stampTemplateRepository.save(template);
    
    try {
        const previewPath = await this.generateAndSavePreview(savedTemplate);
        savedTemplate.previewImagePath = previewPath;
        savedTemplate = await this.stampTemplateRepository.save(savedTemplate);
    } catch (previewError) {
        console.error(`Failed to generate preview for updated template ${savedTemplate.id}:`, previewError);
    }
    return savedTemplate;
  }

  async getTemplatesByIds(ids: number[], user: User): Promise<StampTemplate[]> {
    if (!ids || ids.length === 0) {
      return [];
    }
    
    const whereClause: FindOptionsWhere<StampTemplate> = { id: In(ids) };

    if (!user.isAdmin) {
        whereClause.userId = user.id as string;
    }
    
    return this.stampTemplateRepository.find({
      where: whereClause
    });
  }
}