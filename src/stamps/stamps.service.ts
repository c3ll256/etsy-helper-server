import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, ILike, In } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';

import { StampTemplate, StampType, TextElement } from './entities/stamp-template.entity';
import { StampGenerationRecord } from './entities/stamp-generation-record.entity';
import { CreateStampTemplateDto } from './dto/create-stamp-template.dto';
import { CloneStampTemplateDto } from './dto/clone-stamp-template.dto';
import { UpdateStampTemplateDto } from './dto/update-stamp-template.dto';
import { PythonStampService } from './services/python-stamp.service';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { JobQueueService } from '../common/services/job-queue.service';
import { OrdersService } from '../orders/orders.service';
import { Order } from '../orders/entities/order.entity';

@Injectable()
export class StampsService {
  constructor(
    @InjectRepository(StampTemplate)
    private stampTemplateRepository: Repository<StampTemplate>,
    @InjectRepository(StampGenerationRecord)
    private stampGenerationRecordRepository: Repository<StampGenerationRecord>,
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,
    private readonly pythonStampService: PythonStampService,
    private readonly jobQueueService: JobQueueService,
    @Inject(forwardRef(() => OrdersService))
    private readonly ordersService: OrdersService,
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

    const elementsForPreview: TextElement[] = template.textElements.map(el => ({ 
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
    // Check uniqueness across skus only
    const candidateSkus = Array.from(new Set([...(createStampTemplateDto.skus || [])].filter(Boolean)));
    const templatesWithAliases = await this.stampTemplateRepository.find();
    const conflictByAliases = templatesWithAliases.find(t => Array.isArray(t.skus) && t.skus.some(s => candidateSkus.includes(s)));
    if (conflictByAliases) {
      throw new BadRequestException(`SKU conflict: one or more SKUs already exist in another template.`);
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
      // For Postgres we can use unnest to search skus, fallback to simple ORs otherwise.
      // Keep this as a raw SQL where so it works in PG.
      const whereRaw = `(
        LOWER(template.name) LIKE LOWER(:search)
        OR (
          template.skus IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(template.skus) AS s WHERE LOWER(s) LIKE LOWER(:search)
          )
        )
      )`;
      queryBuilder.andWhere(whereRaw, { search: `%${search}%` });
    }

    queryBuilder
      .leftJoinAndSelect('template.user', 'user')
      .select([
          'template.id', 'template.name', 'template.skus', 'template.backgroundImagePath', 
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
    
    await this.stampTemplateRepository.manager.transaction(async (entityManager) => {
      await entityManager.getRepository(StampGenerationRecord).delete({ templateId: template.id });

      await entityManager.getRepository(Order).update({ templateId: template.id }, { templateId: null });

      const deleteResult = await entityManager.getRepository(StampTemplate).delete(template.id);
      if (deleteResult.affected === 0) {
        throw new NotFoundException(`Stamp template with ID ${id} not found or could not be deleted`);
      }
    });
  }

  async cloneTemplate(
    cloneStampTemplateDto: CloneStampTemplateDto, 
    user: User
  ): Promise<StampTemplate> {
    const { sourceTemplateId, newName, newSku } = cloneStampTemplateDto;
    const sourceTemplate = await this.findById(sourceTemplateId, user);
    
    let finalSku = newSku;
    if (!finalSku) {
        const base = (sourceTemplate.skus && sourceTemplate.skus.length > 0) ? sourceTemplate.skus[0] : 'SKU';
        const timestamp = new Date().getTime();
        finalSku = `${base}-copy-${timestamp}`;
    }

    const templates = await this.stampTemplateRepository.find();
    const exists = templates.some(t => Array.isArray(t.skus) && t.skus.includes(finalSku));
    if (exists) {
      throw new BadRequestException(`SKU "${finalSku}" already exists. Please choose a different SKU.`);
    }

    const clonedTemplateData: Partial<StampTemplate> = {
        skus: [finalSku],
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
    textElements: TextElement[], 
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

  async getGenerationRecordsByTemplateId(templateId: number): Promise<StampGenerationRecord[]> {
    return this.stampGenerationRecordRepository.find({
      where: { templateId },
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
    
    if (updateStampTemplateDto.skus) {
      const candidate = new Set(updateStampTemplateDto.skus.filter(Boolean));
      const others = await this.stampTemplateRepository.find();
      const conflict = others.find(t => t.id !== id && Array.isArray(t.skus) && t.skus.some(s => candidate.has(s)));
      if (conflict) {
        throw new BadRequestException('SKU conflict: one or more SKUs already exist in another template.');
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

  async getTemplatesByStampType(stampType: StampType, user: User): Promise<StampTemplate[]> {
    const whereClause: FindOptionsWhere<StampTemplate> = { type: stampType };

    if (!user.isAdmin) {
        whereClause.userId = user.id as string;
    }
    
    return this.stampTemplateRepository.find({
      where: whereClause
    });
  }

  async regenerateOrderStamps(templateId: number, updatedTemplate: StampTemplate, jobId: string): Promise<void> {
    try {
      // 查找使用该模板的所有订单
      const orders = await this.orderRepository.find({
        where: { templateId },
        relations: ['etsyOrder']
      });

      const totalOrders = orders.length;
      
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'processing',
        progress: 0,
        message: `Starting regeneration of stamps for ${totalOrders} orders`
      });

      let successCount = 0;
      let failedCount = 0;

      // 对每个订单重新生成印章
      for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        
        try {
          if (order.etsyOrder?.stampGenerationRecordIds?.length > 0) {
            // 对每个生成记录重新生成印章
            for (const recordId of order.etsyOrder.stampGenerationRecordIds) {
              // 获取原始生成记录
              const record = await this.getGenerationRecordById(recordId);
              
              if (record) {
                // 使用更新后的模板参数，只保留原始记录中的文本值
                const formattedTextElements: TextElement[] = updatedTemplate.textElements.map((templateElement: TextElement) => {
                  // 从原始记录中找到对应的文本元素
                  const originalElement = record.textElements.find(e => e.id === templateElement.id);
                  
                  // 确保所有必需的属性都存在
                  return {
                    id: templateElement.id,
                    value: originalElement?.value || templateElement.defaultValue || '',
                    fontFamily: templateElement.fontFamily,
                    fontSize: templateElement.fontSize,
                    fontWeight: templateElement.fontWeight,
                    fontStyle: templateElement.fontStyle,
                    color: templateElement.color,
                    description: templateElement.description,
                    isUppercase: templateElement.isUppercase,
                    strokeWidth: templateElement.strokeWidth,
                    textPadding: templateElement.textPadding,
                    firstVariant: templateElement.firstVariant,
                    lastVariant: templateElement.lastVariant,
                    position: {
                      ...templateElement.position,
                    }
                  };
                });

                // 使用更新后的模板和文本元素重新生成印章
                const result = await this.ordersService.updateOrderStamp(order.id, {
                  templateId: updatedTemplate.id,
                  textElements: formattedTextElements as any[],
                  oldRecordId: recordId,
                  convertTextToPaths: true
                });

                if (result.success) {
                  successCount++;
                } else {
                  failedCount++;
                  console.error(`Failed to regenerate stamp for order ${order.id}, record ${recordId}:`, result.error);
                }
              }
            }
          }
        } catch (error) {
          console.error(`Failed to process order ${order.id}:`, error);
          failedCount++;
        }

        // 更新进度
        const progress = Math.round((i + 1) * 100 / totalOrders);
        this.jobQueueService.updateJobProgress(jobId, {
          status: 'processing',
          progress,
          message: `Processed ${i + 1}/${totalOrders} orders. Success: ${successCount}, Failed: ${failedCount}`
        });
      }

      // 更新最终状态
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'completed',
        progress: 100,
        message: `Completed regenerating stamps for ${totalOrders} orders. Success: ${successCount}, Failed: ${failedCount}`,
        result: {
          totalOrders,
          successCount,
          failedCount
        }
      });

      // 设置作业清理定时器
      this.jobQueueService.startJobCleanup(jobId);
    } catch (error) {
      console.error('Failed to regenerate stamps:', error);
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'failed',
        progress: 0,
        message: `Failed to regenerate stamps: ${error.message}`,
        error: error.message
      });
      throw error;
    }
  }
}