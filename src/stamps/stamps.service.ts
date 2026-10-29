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
import { OrderMatchStatus, OrderStatus, UNRESOLVED_MATCH_STATUSES } from '../orders/enums/order.enum';
import { OrderDesignBackup } from '../orders/entities/order-design-backup.entity';
import { StampTemplateShare } from './entities/stamp-template-share.entity';
import { StampCategoriesService } from '../stamp-categories/stamp-categories.service';
import { User as UserEntity } from '../users/entities/user.entity';

@Injectable()
export class StampsService {
  constructor(
    @InjectRepository(StampTemplate)
    private stampTemplateRepository: Repository<StampTemplate>,
    @InjectRepository(StampGenerationRecord)
    private stampGenerationRecordRepository: Repository<StampGenerationRecord>,
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,
    @InjectRepository(OrderDesignBackup)
    private orderDesignBackupRepository: Repository<OrderDesignBackup>,
    @InjectRepository(StampTemplateShare)
    private shareRepository: Repository<StampTemplateShare>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private readonly pythonStampService: PythonStampService,
    private readonly jobQueueService: JobQueueService,
    @Inject(forwardRef(() => OrdersService))
    private readonly ordersService: OrdersService,
    private readonly stampCategoriesService: StampCategoriesService,
  ) {
  }

  private generateCopySku(baseSku: string, suffixSeed: number): string {
    const normalizedBase = (baseSku || 'SKU').trim() || 'SKU';
    return `${normalizedBase}-copy-${suffixSeed}`;
  }

  private async resolveTemplateSkus(
    skus: string[] | undefined,
    userId: string,
    options?: { autoResolveConflicts?: boolean; excludeTemplateId?: number; allowMultipleRattle?: boolean }
  ): Promise<string[]> {
    const requestedSkus = (skus || []).map((sku) => sku?.trim()).filter(Boolean) as string[];
    const uniqueRequestedSkus = Array.from(new Set(requestedSkus));

    const templates = await this.stampTemplateRepository.find({
      where: { userId }
    });

    // 摇铃多模板模式（R1）：多模板模式的摇铃模板之间允许共用 SKU
    const occupiedSkus = new Set(
      templates
        .filter((template) => template.id !== options?.excludeTemplateId)
        .filter((template) => !(options?.allowMultipleRattle && template.type === StampType.RATTLE && template.allowMultipleForSku))
        .flatMap((template) => Array.isArray(template.skus) ? template.skus : [])
        .filter(Boolean)
    );

    if (!options?.autoResolveConflicts) {
      const hasConflict = uniqueRequestedSkus.some((sku) => occupiedSkus.has(sku));
      if (hasConflict) {
        throw new BadRequestException('SKU conflict: one or more SKUs already exist in another template.');
      }
      return uniqueRequestedSkus;
    }

    let suffixSeed = Date.now();
    return uniqueRequestedSkus.map((sku) => {
      if (!occupiedSkus.has(sku)) {
        occupiedSkus.add(sku);
        return sku;
      }

      let resolvedSku = this.generateCopySku(sku, suffixSeed++);
      while (occupiedSkus.has(resolvedSku)) {
        resolvedSku = this.generateCopySku(sku, suffixSeed++);
      }
      occupiedSkus.add(resolvedSku);
      return resolvedSku;
    });
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
    await this.stampCategoriesService.assertCodeExists(createStampTemplateDto.type);
    const resolvedSkus = await this.resolveTemplateSkus(createStampTemplateDto.skus, user.id as string, {
      autoResolveConflicts: createStampTemplateDto.autoResolveSkuConflicts,
      allowMultipleRattle: createStampTemplateDto.type === StampType.RATTLE && !!createStampTemplateDto.allowMultipleForSku,
    });

    const templateData: Partial<StampTemplate> = {
        ...createStampTemplateDto,
        skus: resolvedSkus,
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
      excludeType?: StampType,
  ): Promise<PaginatedResponse<StampTemplate>> {
    const { page = 1, limit = 10 } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.stampTemplateRepository.createQueryBuilder('template');

    if (!user.isAdmin) {
      // 自己的模板 + 被授权使用的模板
      queryBuilder.andWhere(
        `(template.userId = :userId OR template.id IN (SELECT share."templateId" FROM stamp_template_shares share WHERE share."granteeUserId" = :userId))`,
        { userId: user.id as string },
      );
    }

    if (type) {
      queryBuilder.andWhere('template.type = :type', { type });
    }

    if (excludeType) {
      queryBuilder.andWhere('template.type != :excludeType', { excludeType });
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
          'template.type', 'template.previewImagePath', 'template.isActive', 'template.allowMultipleForSku', 'template.createdAt',
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
      const share = await this.shareRepository.findOne({ where: { templateId: id, granteeUserId: user.id as string } });
      if (!share) {
        throw new ForbiddenException('You do not have permission to access this template');
      }
    }
    
    return template;
  }

  /** 被授权账号只能查看和使用模板，不能修改、删除或管理授权 */
  private assertCanEdit(template: StampTemplate, user: User): void {
    if (!user.isAdmin && template.userId !== user.id) {
      throw new ForbiddenException('这是其他账号授权给你使用的模板，只能查看和使用，不能修改；需要独立维护请先"复制模板"');
    }
  }

  async listShares(templateId: number, user: User) {
    const template = await this.findById(templateId, user);
    this.assertCanEdit(template, user);
    const shares = await this.shareRepository.find({ where: { templateId }, order: { createdAt: 'ASC' } });
    const users = shares.length
      ? await this.userRepository.find({ where: { id: In(shares.map(s => s.granteeUserId)) } })
      : [];
    return shares.map(share => ({
      ...share,
      granteeUsername: users.find(u => u.id === share.granteeUserId)?.username ?? null,
    }));
  }

  /** 设置模板的被授权账号（整体替换） */
  async setShares(templateId: number, granteeUserIds: string[], user: User) {
    const template = await this.findById(templateId, user);
    this.assertCanEdit(template, user);
    const ids = Array.from(new Set((granteeUserIds || []).filter(id => id && id !== template.userId)));
    await this.shareRepository.delete({ templateId });
    if (ids.length) {
      await this.shareRepository.save(ids.map(granteeUserId => this.shareRepository.create({
        templateId,
        granteeUserId,
        permission: 'use',
        createdBy: user.id as string,
      })));
    }
    return this.listShares(templateId, user);
  }

  /**
   * 批量授权：把某个账号的模板（可按类型筛选：stamp 印章 / rattle 摇铃）授权给其他账号使用。
   * 普通账号只能授权自己的模板；管理员可以指定 ownerUserId。
   * mode=grant 追加授权；mode=revoke 撤销这些模板对这些账号的授权。
   */
  async bulkShare(
    params: { ownerUserId?: string; templateIds?: number[]; granteeUserIds: string[]; category?: 'stamp' | 'rattle' | 'all'; mode?: 'grant' | 'revoke' },
    user: User,
  ) {
    const ownerUserId = user.isAdmin && params.ownerUserId ? params.ownerUserId : (user.id as string);
    const qb = this.stampTemplateRepository.createQueryBuilder('template').where('template.userId = :ownerUserId', { ownerUserId });
    if (params.templateIds?.length) {
      qb.andWhere('template.id IN (:...templateIds)', { templateIds: params.templateIds });
    }
    if (params.category === 'rattle') {
      qb.andWhere('template.type = :rattle', { rattle: StampType.RATTLE });
    } else if (params.category === 'stamp') {
      qb.andWhere('template.type != :rattle', { rattle: StampType.RATTLE });
    }
    const templates = await qb.getMany();
    const granteeIds = Array.from(new Set((params.granteeUserIds || []).filter(id => id && id !== ownerUserId)));
    if (!granteeIds.length) {
      throw new BadRequestException('请选择被授权的账号');
    }

    let affected = 0;
    for (const template of templates) {
      for (const granteeUserId of granteeIds) {
        if (params.mode === 'revoke') {
          const result = await this.shareRepository.delete({ templateId: template.id, granteeUserId });
          affected += result.affected || 0;
        } else {
          const exists = await this.shareRepository.findOne({ where: { templateId: template.id, granteeUserId } });
          if (!exists) {
            await this.shareRepository.save(this.shareRepository.create({
              templateId: template.id,
              granteeUserId,
              permission: 'use',
              createdBy: user.id as string,
            }));
            affected++;
          }
        }
      }
    }
    return { templateCount: templates.length, granteeCount: granteeIds.length, affected, mode: params.mode || 'grant' };
  }

  /** 某账号被授权使用的模板数量（按授权来源账号汇总），用于账号管理页展示 */
  async getShareSummaryForUser(granteeUserId: string) {
    const rows = await this.shareRepository.createQueryBuilder('share')
      .innerJoin('share.template', 'template')
      .innerJoin('template.user', 'owner')
      .select('owner.username', 'ownerUsername')
      .addSelect('owner.id', 'ownerUserId')
      .addSelect(`SUM(CASE WHEN template.type = 'rattle' THEN 1 ELSE 0 END)`, 'rattle')
      .addSelect(`SUM(CASE WHEN template.type != 'rattle' THEN 1 ELSE 0 END)`, 'stamp')
      .where('share.granteeUserId = :granteeUserId', { granteeUserId })
      .groupBy('owner.id')
      .addGroupBy('owner.username')
      .getRawMany();
    return rows.map(row => ({ ...row, rattle: Number(row.rattle), stamp: Number(row.stamp) }));
  }

  async remove(id: number, user: User): Promise<void> {
    const template = await this.findById(id, user);
    this.assertCanEdit(template, user);
    
    // 软删除：模板不再出现在列表和 SKU 匹配中，但历史订单的 templateId 和生成记录保持不变
    const deleteResult = await this.stampTemplateRepository.softDelete(template.id);
    if (deleteResult.affected === 0) {
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
        const base = (sourceTemplate.skus && sourceTemplate.skus.length > 0) ? sourceTemplate.skus[0] : 'SKU';
        const timestamp = new Date().getTime();
        finalSku = `${base}-copy-${timestamp}`;
    }

    const templates = await this.stampTemplateRepository.find({
      where: { userId: user.id as string }
    });
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
      relations: ['template'],
      withDeleted: true, // 模板软删除后，历史记录仍需展示模板信息
    });
  }

  async getGenerationRecordById(id: number): Promise<StampGenerationRecord> {
    const record = await this.stampGenerationRecordRepository.findOne({
      where: { id },
      relations: ['template'],
      withDeleted: true, // 模板软删除后，历史记录仍需展示模板信息
    });
    
    if (!record) {
      throw new NotFoundException(`Stamp generation record with ID ${id} not found`);
    }
    
    return record;
  }

  async getLatestGenerationRecord(): Promise<StampGenerationRecord | null> {
    return this.stampGenerationRecordRepository.findOne({
      order: { createdAt: 'DESC' },
      relations: ['template'],
      withDeleted: true, // 模板软删除后，历史记录仍需展示模板信息
    });
  }

  async getLatestGenerationRecordByOrderId(orderId: string): Promise<StampGenerationRecord | null> {
    return this.stampGenerationRecordRepository.findOne({
      where: { orderId },
      order: { createdAt: 'DESC' },
      relations: ['template'],
      withDeleted: true, // 模板软删除后，历史记录仍需展示模板信息
    });
  }

  async getGenerationRecordsByTemplateId(templateId: number): Promise<StampGenerationRecord[]> {
    return this.stampGenerationRecordRepository.find({
      where: { templateId },
      order: { createdAt: 'DESC' },
      relations: ['template'],
      withDeleted: true, // 模板软删除后，历史记录仍需展示模板信息
    });
  }

  async update(
    id: number, 
    updateStampTemplateDto: UpdateStampTemplateDto, 
    user: User
  ): Promise<StampTemplate> {
    let template = await this.findById(id, user);
    this.assertCanEdit(template, user);
    if (updateStampTemplateDto.type && updateStampTemplateDto.type !== template.type) {
      await this.stampCategoriesService.assertCodeExists(updateStampTemplateDto.type);
    }

    if (updateStampTemplateDto.skus) {
      const nextType = updateStampTemplateDto.type ?? template.type;
      const nextMulti = updateStampTemplateDto.allowMultipleForSku ?? template.allowMultipleForSku;
      // SKU 唯一性按模板所有者检查（管理员改别人的模板时也一样）
      updateStampTemplateDto.skus = await this.resolveTemplateSkus(updateStampTemplateDto.skus, template.userId, {
        excludeTemplateId: id,
        allowMultipleRattle: nextType === StampType.RATTLE && !!nextMulti,
      });
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
      const allOrders = await this.orderRepository.find({
        where: { templateId },
        relations: ['etsyOrder']
      });

      // 已审核通过、人工调整过的设计不随模板更新自动覆盖，需在订单内单独处理（重新处理时确认）
      const orders = allOrders.filter(order =>
        order.status !== OrderStatus.STAMP_GENERATED_REVIEWED
        && !order.designAdjustedAt
        && !UNRESOLVED_MATCH_STATUSES.includes(order.matchStatus as OrderMatchStatus));
      const skippedReviewedCount = allOrders.filter(order => order.status === OrderStatus.STAMP_GENERATED_REVIEWED).length;
      const skippedAdjustedCount = allOrders.filter(order =>
        order.status !== OrderStatus.STAMP_GENERATED_REVIEWED && !!order.designAdjustedAt).length;

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
            // 覆盖前备份当前设计（旧记录和图片文件保留）
            await this.orderDesignBackupRepository.save(this.orderDesignBackupRepository.create({
              orderId: order.id,
              templateId: order.templateId,
              status: order.status,
              matchStatus: order.matchStatus,
              stampImageUrls: order.etsyOrder.stampImageUrls || [],
              stampGenerationRecordIds: order.etsyOrder.stampGenerationRecordIds || [],
              variations: order.etsyOrder.variations ?? null,
              reason: 'template_update',
            }));
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
                    },
                    icon: templateElement.icon ? { ...templateElement.icon } : undefined,
                  };
                });

                // 使用更新后的模板和文本元素重新生成印章
                const result = await this.ordersService.updateOrderStamp(order.id, {
                  templateId: updatedTemplate.id,
                  textElements: formattedTextElements as any[],
                  oldRecordId: recordId,
                  convertTextToPaths: true
                }, undefined, { markAdjusted: false });

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
        message: `Completed regenerating stamps for ${totalOrders} orders. Success: ${successCount}, Failed: ${failedCount}, Skipped reviewed: ${skippedReviewedCount}, Skipped adjusted: ${skippedAdjustedCount}`,
        result: {
          totalOrders,
          successCount,
          failedCount,
          skippedReviewedCount,
          skippedAdjustedCount
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
