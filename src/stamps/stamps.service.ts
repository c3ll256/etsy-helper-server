import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { In } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';

import { StampTemplate } from './entities/stamp-template.entity';
import { StampGenerationRecord } from './entities/stamp-generation-record.entity';
import { CreateStampTemplateDto } from './dto/create-stamp-template.dto';
import { CloneStampTemplateDto } from './dto/clone-stamp-template.dto';
import { UpdateStampTemplateDto } from './dto/update-stamp-template.dto';
import { PythonStampService } from './services/python-stamp.service';

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
    const previewDir = path.join(process.cwd(), 'uploads', 'previews');
    if (!fs.existsSync(previewDir)) {
      fs.mkdirSync(previewDir, { recursive: true });
    }

    const previewFileName = `preview-${Date.now()}-${Math.random().toString(36).substring(7)}.png`;
    const previewPath = path.join(previewDir, previewFileName);

    for (const textElement of template.textElements) {
      textElement.value = textElement.defaultValue
    }

    const buffer = await this.pythonStampService.generateStamp({
      template,
      textElements: template.textElements,
      convertTextToPaths: false
    });

    fs.writeFileSync(previewPath, buffer);
    return `uploads/previews/${previewFileName}`;
  }

  async create(createStampTemplateDto: CreateStampTemplateDto): Promise<StampTemplate> {
    const template = this.stampTemplateRepository.create(createStampTemplateDto);
    const savedTemplate = await this.stampTemplateRepository.save(template);
    
    // Generate and save preview
    savedTemplate.previewImagePath = await this.generateAndSavePreview(savedTemplate);
    return this.stampTemplateRepository.save(savedTemplate);
  }

  async findAll(): Promise<StampTemplate[]> {
    return this.stampTemplateRepository.find();
  }

  async findById(id: number): Promise<StampTemplate> {
    let template: StampTemplate;

    template = await this.stampTemplateRepository.findOne({ where: { id } });

    if (!template) {
      throw new NotFoundException(`Stamp template with ID ${id} not found`);
    }
    
    return template;
  }

  async remove(id: number): Promise<void> {
    const result = await this.stampTemplateRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`Stamp template with ID ${id} not found`);
    }
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

  // 创建印章生成记录
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

  // 根据订单ID获取印章生成记录
  async getGenerationRecordsByOrderId(orderId: string): Promise<StampGenerationRecord[]> {
    return this.stampGenerationRecordRepository.find({
      where: { orderId },
      order: { createdAt: 'DESC' },
      relations: ['template']
    });
  }

  // 根据记录ID获取特定的印章生成记录
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

  // 获取最新一条印章生成记录（无论是哪个订单）
  async getLatestGenerationRecord(): Promise<StampGenerationRecord | null> {
    return this.stampGenerationRecordRepository.findOne({
      order: { createdAt: 'DESC' },
      relations: ['template']
    });
  }

  // 获取指定订单的最新一条印章生成记录
  async getLatestGenerationRecordByOrderId(orderId: string): Promise<StampGenerationRecord | null> {
    return this.stampGenerationRecordRepository.findOne({
      where: { orderId },
      order: { createdAt: 'DESC' },
      relations: ['template']
    });
  }

  async update(id: number, updateStampTemplateDto: UpdateStampTemplateDto): Promise<StampTemplate> {
    const template = await this.findById(id);
    
    // If SKU is being updated, check if it already exists
    if (updateStampTemplateDto.sku && updateStampTemplateDto.sku !== template.sku) {
      const existingTemplate = await this.stampTemplateRepository.findOne({ 
        where: { sku: updateStampTemplateDto.sku }
      });
      
      if (existingTemplate && existingTemplate.id !== id) {
        throw new BadRequestException(`Template with SKU "${updateStampTemplateDto.sku}" already exists`);
      }
    }
    
    // Update the template with new values
    const updatedTemplate = this.stampTemplateRepository.merge(template, updateStampTemplateDto);
    const savedTemplate = await this.stampTemplateRepository.save(updatedTemplate);
    
    // Generate and save new preview
    savedTemplate.previewImagePath = await this.generateAndSavePreview(savedTemplate);
    return this.stampTemplateRepository.save(savedTemplate);
  }

  // 根据模板ID数组获取模板列表
  async getTemplatesByIds(ids: number[]): Promise<StampTemplate[]> {
    if (!ids || ids.length === 0) {
      return [];
    }
    
    return this.stampTemplateRepository.find({
      where: { id: In(ids) }
    });
  }
}