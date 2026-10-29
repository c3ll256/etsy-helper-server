import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository, Not, In } from 'typeorm';
import * as fs from 'fs';
import { read, utils } from 'xlsx';
import * as ExcelJS from 'exceljs';
import { toBuffer as generateQrBuffer } from 'qrcode';
import * as dayjs from 'dayjs';
import * as AdmZip from 'adm-zip';
import * as path from 'path';
import * as process from 'process';

import { BasketGenerationRecord } from './entities/basket-generation-record.entity';
import { PythonBasketService } from './services/python-basket.service';
import { BasketLinesService } from './basket-lines.service';
import { BasketGenerationResponseDto } from './dto/basket-generation-response.dto';
import { User } from '../users/entities/user.entity';
import { BasketPaginationDto } from './dto/basket-pagination.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { JobQueueService } from '../common/services/job-queue.service';
import { SkuConfig, SkuType } from './entities/sku-config.entity';
import { CreateSkuConfigDto, BatchUpdateSkuConfigItemDto } from './dto/sku-config.dto';
import { AliyunService } from 'src/common/services/aliyun.service';
import { RemoteAreaService } from 'src/common/services/remote-area.service';
import { replaceSkuDisplayValue } from './sku-display.util';
import { ColorGroup } from './entities/color-group.entity';
import { ColorKv } from './entities/color-kv.entity';
import { IconGroup } from './entities/icon-group.entity';
import { IconKv } from './entities/icon-kv.entity';
import { BasketIconLayoutTemplate } from './entities/basket-icon-layout-template.entity';
import {
  CreateColorGroupDto,
  CreateColorKvDto,
  CreateColorKvBatchDto,
  CreateIconGroupDto,
  DeleteColorKvBatchDto,
  CreateIconKvDto,
  QueryColorGroupsDto,
  QueryColorKvDto,
  QueryIconGroupsDto,
  QueryIconKvDto,
  UpdateColorGroupDto,
  UpdateColorKvDto,
  UpdateIconGroupDto,
  UpdateIconKvDto,
} from './dto/basket-dictionaries.dto';

interface GroupBindingSummary {
  boundSkuCount: number;
  boundSkus: string[];
}

class JobCancelledError extends Error {
  constructor(message?: string) {
    super(message || '订单文件生成任务已取消');
    this.name = 'JobCancelledError';
  }
}

/** 上传时选择的订单类型：all 或某个 SKU 配置类型 */
export type BasketUploadOrderType = 'all' | SkuType;

const ORDER_TYPE_LABELS: Record<BasketUploadOrderType, string> = {
  all: '所有类型',
  [SkuType.MATERNAL_BABY]: '母婴单品',
  [SkuType.COMBO]: '组合',
  [SkuType.SWEATER]: '毛衣',
};

@Injectable()
export class BasketService {
  private readonly logger = new Logger(BasketService.name);
  private readonly uploadsDir = 'uploads/baskets';

  private isAdminGlobalSkuMatchEnabled(): boolean {
    return process.env.ENABLE_ADMIN_GLOBAL_SKU_MATCH === 'true';
  }

  constructor(
    @InjectRepository(BasketGenerationRecord)
    private readonly basketRecordRepository: Repository<BasketGenerationRecord>,
    @InjectRepository(SkuConfig)
    private readonly skuConfigRepository: Repository<SkuConfig>,
    @InjectRepository(ColorGroup)
    private readonly colorGroupRepository: Repository<ColorGroup>,
    @InjectRepository(ColorKv)
    private readonly colorKvRepository: Repository<ColorKv>,
    @InjectRepository(IconGroup)
    private readonly iconGroupRepository: Repository<IconGroup>,
    @InjectRepository(IconKv)
    private readonly iconKvRepository: Repository<IconKv>,
    @InjectRepository(BasketIconLayoutTemplate)
    private readonly templateRepository: Repository<BasketIconLayoutTemplate>,
    private readonly pythonBasketService: PythonBasketService,
    private readonly basketLinesService: BasketLinesService,
    private readonly jobQueueService: JobQueueService,
    private readonly aliyunService: AliyunService,
    private readonly remoteAreaService: RemoteAreaService,
  ) {
    // Ensure uploads directory exists
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
  }

  /**
   * Generate basket orders PPT from Excel file
   * @param file Uploaded Excel file
   * @param user 当前登录用户
   * @param originalFilename Original filename
   * @param orderType 订单类型 (篮子 或 书包)
   * @returns Basket generation record
   */
  async generateBasketOrders(
    file: Express.Multer.File, 
    user: User,
    originalFilename?: string,
    orderType: BasketUploadOrderType = 'all'
  ): Promise<BasketGenerationResponseDto> {
    const allowAdminGlobalSkuMatch = user.isAdmin && this.isAdminGlobalSkuMatchEnabled();

    // Check if user has SKU configuration
    const findOptions: any = {
      where: allowAdminGlobalSkuMatch ? {} : { userId: user.id },
      order: { createdAt: 'DESC' }
    };

    // Filter configs by type if orderType is specific
    if (orderType !== 'all') {
      if (!Object.values(SkuType).includes(orderType)) {
        throw new BadRequestException(`不支持的订单类型 '${orderType}'`);
      }
      findOptions.where.type = orderType;
    }
    
    const userConfigs = await this.skuConfigRepository.find(findOptions);
    
    if (!userConfigs.length) {
      let message = '您尚未配置SKU匹配规则，请先前往设置页面进行配置';
      if (orderType !== 'all') {
          message = `您尚未配置类型为 '${orderType}' 的SKU匹配规则，请先前往设置页面进行配置或选择 '所有类型'`;
      }
      throw new BadRequestException(message);
    }
    
    // Create a new record
    const record = this.basketRecordRepository.create({
      originalFilename: originalFilename || file.originalname,
      status: 'pending',
      progress: 0,
      userId: user.id,
      orderType: orderType // 保存订单类型到记录中
    });

    // Save to get an ID
    const savedRecord = await this.basketRecordRepository.save(record);
    
    // Create a job ID in the job queue
    const jobId = this.jobQueueService.createJob(user.id);

    await this.basketRecordRepository.update(savedRecord.id, { jobId });

    savedRecord.jobId = jobId;

    // Start processing in background
    this.processBasketOrdersAsync(savedRecord.id, file, jobId, user, orderType);

    // Return the record
    return {
      id: savedRecord.id,
      jobId: jobId,
      status: savedRecord.status,
      progress: savedRecord.progress,
      originalFilename: savedRecord.originalFilename,
      createdAt: savedRecord.createdAt,
      orderType: orderType, // 在响应中包含订单类型
      output: null // 初始状态下output为null，完成后将包含zip文件信息
    };
  }

  /**
   * Get user's SKU configurations with pagination
   * @param user Current user
   * @param options Pagination options
   * @returns Paginated list of SKU configurations
   */
  async getUserSkuConfigs(
    user: User,
    options: { page: number; limit: number; search?: string; colorGroupId?: number }
  ): Promise<PaginatedResponse<SkuConfig>> {
    const { page = 1, limit = 10, search, colorGroupId } = options;
    const skip = (page - 1) * limit;

    // Create query builder
    const queryBuilder = this.skuConfigRepository.createQueryBuilder('config')
      .leftJoinAndSelect('config.user', 'user')
      .leftJoinAndSelect('config.colorGroup', 'colorGroup')
      .leftJoinAndSelect('config.iconGroup', 'iconGroup')
      .orderBy('config.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    // Apply search filter if provided
    if (search) {
      queryBuilder.andWhere(
        '(config.sku ILIKE :search OR config.replaceValue ILIKE :search)',
        { search: `%${search}%` }
      );
    }

    if (colorGroupId) {
      queryBuilder.andWhere('config.colorGroupId = :colorGroupId', { colorGroupId });
    }

    // Apply user filter based on role
    if (!user.isAdmin) {
      // Regular users can only see their own configs
      queryBuilder.andWhere('config.userId = :userId', { userId: user.id });
    }

    // Get results with count
    const [items, total] = await queryBuilder.getManyAndCount();

    // Return paginated response
    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Create a new SKU configuration
   * @param userId User ID
   * @param configDto Configuration data
   * @returns Created configuration
   */
  async createSkuConfig(userId: string, configDto: CreateSkuConfigDto): Promise<SkuConfig> {
    // Check if SKU already exists for this user
    const existingConfig = await this.skuConfigRepository.findOne({
      where: { 
        userId,
        sku: configDto.sku
      }
    });

    if (existingConfig) {
      throw new BadRequestException(`SKU ${configDto.sku} 已存在配置`);
    }

    await this.validateSkuConfigReferences(userId, configDto);

    const config = this.skuConfigRepository.create({
      userId,
      ...configDto
    });
    
    return this.skuConfigRepository.save(config);
  }

  /**
   * Update an existing SKU configuration
   * @param id Configuration ID
   * @param userId User ID
   * @param configDto Configuration data
   * @returns Updated configuration
   */
  async updateSkuConfig(id: number, userId: string, configDto: CreateSkuConfigDto): Promise<SkuConfig> {
    const config = await this.skuConfigRepository.findOne({
      where: { id, userId }
    });

    if (!config) {
      throw new NotFoundException(`SKU配置ID ${id} 不存在`);
    }

    // Check if new SKU already exists for this user (excluding current config)
    const existingConfig = await this.skuConfigRepository.findOne({
      where: { 
        userId,
        sku: configDto.sku,
        id: Not(id)
      }
    });

    if (existingConfig) {
      throw new BadRequestException(`SKU ${configDto.sku} 已存在配置`);
    }

    await this.validateSkuConfigReferences(userId, configDto);

    // Update the configuration
    this.skuConfigRepository.merge(config, configDto);
    return this.skuConfigRepository.save(config);
  }

  /**
   * Delete a SKU configuration
   * @param id Configuration ID
   * @param userId User ID
   */
  async deleteSkuConfig(id: number, userId: string): Promise<void> {
    const result = await this.skuConfigRepository.delete({ id, userId });
    
    if (result.affected === 0) {
      throw new NotFoundException(`SKU配置ID ${id} 不存在`);
    }
  }

  /**
   * Batch update SKU configurations
   * @param userId User ID
   * @param configs Array of configuration updates
   * @returns Array of updated configurations
   */
  async batchUpdateSkuConfigs(
    userId: string,
    configs: BatchUpdateSkuConfigItemDto[]
  ): Promise<SkuConfig[]> {
    const updatedConfigs: SkuConfig[] = [];
    const errors: Array<{ id: number; reason: string }> = [];

    for (const configUpdate of configs) {
      try {
        const { id, ...updateData } = configUpdate;
        
        // Find the configuration
        const config = await this.skuConfigRepository.findOne({
          where: { id, userId }
        });

        if (!config) {
          errors.push({ id, reason: `SKU配置ID ${id} 不存在` });
          continue;
        }

        // Build update object with only defined fields (excluding undefined)
        const updateFields: Partial<SkuConfig> = {};
        
        // Only include fields that are explicitly provided (not undefined)
        if (updateData.sku !== undefined) {
          // Check if SKU is being changed and if it conflicts with existing config
          if (updateData.sku !== config.sku) {
            const existingConfig = await this.skuConfigRepository.findOne({
              where: { 
                userId,
                sku: updateData.sku,
                id: Not(id)
              }
            });

            if (existingConfig) {
              errors.push({ id, reason: `SKU ${updateData.sku} 已存在配置` });
              continue;
            }
          }
          updateFields.sku = updateData.sku;
        }
        
        if (updateData.type !== undefined) updateFields.type = updateData.type;
        if (updateData.replaceValue !== undefined) updateFields.replaceValue = updateData.replaceValue;
        if (updateData.fontSize !== undefined) updateFields.fontSize = updateData.fontSize;
        if (updateData.font !== undefined) updateFields.font = updateData.font;
        if (updateData.yarnColorMap !== undefined) updateFields.yarnColorMap = updateData.yarnColorMap;
        if (updateData.comboItems !== undefined) updateFields.comboItems = updateData.comboItems as any;
        if (updateData.colorGroupId !== undefined) updateFields.colorGroupId = updateData.colorGroupId;
        if (updateData.iconGroupId !== undefined) updateFields.iconGroupId = updateData.iconGroupId;
        if (updateData.comboOverridesJson !== undefined) updateFields.comboOverridesJson = updateData.comboOverridesJson as any;
        if (updateData.externalOrderReminderEnabled !== undefined) updateFields.externalOrderReminderEnabled = updateData.externalOrderReminderEnabled;
        if (updateData.externalOrderReminderContent !== undefined) updateFields.externalOrderReminderContent = updateData.externalOrderReminderContent;
        if (updateData.produceMode !== undefined) updateFields.produceMode = updateData.produceMode;
        if (updateData.iconLayoutTemplateId !== undefined) updateFields.iconLayoutTemplateId = updateData.iconLayoutTemplateId;
        if (updateData.maxIcons !== undefined) updateFields.maxIcons = updateData.maxIcons;
        if (updateData.nameLayout !== undefined) updateFields.nameLayout = updateData.nameLayout;
        if (updateData.referenceGroupKey !== undefined) updateFields.referenceGroupKey = updateData.referenceGroupKey;

        // Check if there are any fields to update
        if (Object.keys(updateFields).length === 0) {
          errors.push({ id, reason: '没有提供任何要更新的字段' });
          continue;
        }

        const nextColorGroupId = Object.prototype.hasOwnProperty.call(updateFields, 'colorGroupId')
          ? updateFields.colorGroupId
          : config.colorGroupId
        const nextIconGroupId = Object.prototype.hasOwnProperty.call(updateFields, 'iconGroupId')
          ? updateFields.iconGroupId
          : config.iconGroupId

        await this.validateSkuConfigReferences(userId, {
          sku: updateFields.sku ?? config.sku,
          type: updateFields.type ?? config.type,
          replaceValue: updateFields.replaceValue ?? config.replaceValue,
          fontSize: updateFields.fontSize ?? config.fontSize,
          font: updateFields.font ?? config.font,
          yarnColorMap: updateFields.yarnColorMap ?? config.yarnColorMap,
          comboItems: (updateFields.comboItems ?? config.comboItems) as string[] | undefined,
          colorGroupId: nextColorGroupId,
          iconGroupId: nextIconGroupId,
          comboOverridesJson: (updateFields.comboOverridesJson ?? config.comboOverridesJson) as any,
          externalOrderReminderEnabled: updateFields.externalOrderReminderEnabled ?? config.externalOrderReminderEnabled,
          externalOrderReminderContent: updateFields.externalOrderReminderContent ?? config.externalOrderReminderContent,
          iconLayoutTemplateId: (updateFields.iconLayoutTemplateId ?? config.iconLayoutTemplateId) as any,
          nameLayout: (updateFields.nameLayout ?? config.nameLayout) as any,
        });

        // Update the configuration with only the provided fields
        this.skuConfigRepository.merge(config, updateFields);
        const savedConfig = await this.skuConfigRepository.save(config);
        updatedConfigs.push(savedConfig);
      } catch (error) {
        const reason = error instanceof Error ? error.message : '未知错误';
        errors.push({ id: configUpdate.id, reason });
      }
    }

    if (errors.length > 0 && updatedConfigs.length === 0) {
      throw new BadRequestException(`批量更新失败: ${errors.map(e => `ID ${e.id}: ${e.reason}`).join('; ')}`);
    }

    if (errors.length > 0) {
      this.logger.warn(`批量更新部分失败: ${errors.map(e => `ID ${e.id}: ${e.reason}`).join('; ')}`);
    }

    return updatedConfigs;
  }

  async listColorGroups(user: User, query: QueryColorGroupsDto): Promise<PaginatedResponse<ColorGroup>> {
    const page = query.page && query.page > 0 ? Number(query.page) : 1;
    const limit = query.limit && query.limit > 0 ? Number(query.limit) : 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.colorGroupRepository.createQueryBuilder('group')
      .where('group.isActive = :isActive', { isActive: true })
      .orderBy('group.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (!user.isAdmin) {
      queryBuilder.andWhere('group.userId = :userId', { userId: user.id });
    }

    if (query.search?.trim()) {
      queryBuilder.andWhere('group.name ILIKE :search', { search: `%${query.search.trim()}%` });
    }

    if (query.productType?.trim()) {
      queryBuilder.andWhere('group.productType = :productType', { productType: query.productType.trim() });
    }

    const [items, total] = await queryBuilder.getManyAndCount();
    const summaries = await this.getGroupBindingSummaries('color', items.map((item) => item.id));
    return {
      items: items.map((item) => ({ ...item, ...(summaries.get(item.id) || this.emptyBindingSummary()) })) as any,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async createColorGroup(user: User, dto: CreateColorGroupDto): Promise<ColorGroup> {
    const group = this.colorGroupRepository.create({
      userId: user.id,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      productType: dto.productType,
      isActive: true,
    });
    return this.colorGroupRepository.save(group);
  }

  async updateColorGroup(id: number, user: User, dto: UpdateColorGroupDto): Promise<ColorGroup> {
    const group = await this.getOwnedColorGroup(id, user);
    if (dto.name !== undefined) group.name = dto.name.trim();
    if (dto.description !== undefined) group.description = dto.description?.trim() || null;
    if (dto.productType !== undefined) group.productType = dto.productType;
    return this.colorGroupRepository.save(group);
  }

  async getColorGroup(id: number, user: User): Promise<ColorGroup> {
    const group = await this.getOwnedColorGroup(id, user);
    const summary = await this.getGroupBindingSummary('color', id);
    return { ...group, ...summary } as any;
  }

  async deleteColorGroup(id: number, user: User): Promise<void> {
    const group = await this.getOwnedColorGroup(id, user);
    const activeBinding = await this.skuConfigRepository.findOne({ where: { colorGroupId: id } });
    if (activeBinding) {
      throw new BadRequestException('该颜色组仍被 SKU 配置引用，请先解除绑定');
    }
    group.isActive = false;
    await this.colorGroupRepository.save(group);
  }

  async listColorKv(user: User, query: QueryColorKvDto): Promise<PaginatedResponse<ColorKv>> {
    const page = query.page && query.page > 0 ? Number(query.page) : 1;
    const limit = query.limit && query.limit > 0 ? Number(query.limit) : 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.colorKvRepository.createQueryBuilder('kv')
      .leftJoinAndSelect('kv.group', 'group')
      .where('kv.isActive = :isActive', { isActive: true })
      .orderBy('kv.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (!user.isAdmin) {
      queryBuilder.andWhere('kv.userId = :userId', { userId: user.id });
    }

    if (query.groupId) {
      queryBuilder.andWhere('kv.groupId = :groupId', { groupId: query.groupId });
    }

    if (query.search?.trim()) {
      queryBuilder.andWhere('(kv.name ILIKE :search OR kv.colorValue ILIKE :search)', { search: `%${query.search.trim()}%` });
    }

    const [items, total] = await queryBuilder.getManyAndCount();
    return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async createColorKv(user: User, dto: CreateColorKvDto): Promise<ColorKv> {
    let groupId: number | null = null;

    if (dto.groupId) {
      const group = await this.getOwnedColorGroup(dto.groupId, user);
      groupId = group.id;
    }
    const normalizedColorValue = this.normalizeColorValue(dto.colorValue);

    const entity = this.colorKvRepository.create({
      userId: user.id,
      groupId,
      name: dto.name.trim(),
      colorValue: normalizedColorValue,
      isActive: true,
    });
    return this.colorKvRepository.save(entity);
  }

  async createColorKvBatch(user: User, dto: CreateColorKvBatchDto): Promise<ColorKv[]> {
    let groupId: number | null = null;

    if (dto.groupId) {
      const group = await this.getOwnedColorGroup(dto.groupId, user);
      groupId = group.id;
    }

    if (!dto.items?.length) {
      throw new BadRequestException('批量新增内容不能为空');
    }

    const entities = dto.items.map((item) => this.colorKvRepository.create({
      userId: user.id,
      groupId,
      name: item.name.trim(),
      colorValue: this.normalizeColorValue(item.colorValue),
      isActive: true,
    }));

    return this.colorKvRepository.save(entities);
  }

  async updateColorKv(id: number, user: User, dto: UpdateColorKvDto): Promise<ColorKv> {
    const kv = await this.getOwnedColorKv(id, user);
    if (dto.groupId !== undefined) {
      if (dto.groupId === null) {
        kv.groupId = null;
        kv.group = null;
      } else {
        const group = await this.getOwnedColorGroup(dto.groupId, user);
        kv.groupId = group.id;
        kv.group = group;
      }
    }
    if (dto.name !== undefined) kv.name = dto.name.trim();
    if (dto.colorValue !== undefined) {
      kv.colorValue = this.normalizeColorValue(dto.colorValue);
    }
    return this.colorKvRepository.save(kv);
  }

  async deleteColorKv(id: number, user: User): Promise<void> {
    const kv = await this.getOwnedColorKv(id, user);
    kv.isActive = false;
    await this.colorKvRepository.save(kv);
  }

  async deleteColorKvBatch(ids: number[], user: User): Promise<{ deletedIds: number[] }> {
    if (!ids?.length) {
      throw new BadRequestException('请选择要删除的颜色字典项');
    }

    const deletedIds: number[] = [];
    for (const id of ids) {
      const kv = await this.getOwnedColorKv(id, user);
      kv.isActive = false;
      await this.colorKvRepository.save(kv);
      deletedIds.push(id);
    }

    return { deletedIds };
  }

  async listIconGroups(user: User, query: QueryIconGroupsDto): Promise<PaginatedResponse<IconGroup>> {
    const page = query.page && query.page > 0 ? Number(query.page) : 1;
    const limit = query.limit && query.limit > 0 ? Number(query.limit) : 20;
    const skip = (page - 1) * limit;
    const where = !user.isAdmin ? { userId: user.id, isActive: true, ...(query.search ? { name: ILike(`%${query.search.trim()}%`) } : {}) } : { isActive: true, ...(query.search ? { name: ILike(`%${query.search.trim()}%`) } : {}) };
    const [items, total] = await this.iconGroupRepository.findAndCount({ where, order: { createdAt: 'DESC' }, skip, take: limit });
    const summaries = await this.getGroupBindingSummaries('icon', items.map((item) => item.id));
    return {
      items: items.map((item) => ({ ...item, ...(summaries.get(item.id) || this.emptyBindingSummary()) })) as any,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async createIconGroup(user: User, dto: CreateIconGroupDto): Promise<IconGroup> {
    const group = this.iconGroupRepository.create({
      userId: user.id,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      productType: dto.productType,
      isActive: true
    });
    return this.iconGroupRepository.save(group);
  }

  async updateIconGroup(id: number, user: User, dto: UpdateIconGroupDto): Promise<IconGroup> {
    const group = await this.getOwnedIconGroup(id, user);
    if (dto.name !== undefined) group.name = dto.name.trim();
    if (dto.description !== undefined) group.description = dto.description?.trim() || null;
    if (dto.productType !== undefined) group.productType = dto.productType;
    return this.iconGroupRepository.save(group);
  }

  async getIconGroup(id: number, user: User): Promise<IconGroup> {
    const group = await this.getOwnedIconGroup(id, user);
    const summary = await this.getGroupBindingSummary('icon', id);
    return { ...group, ...summary } as any;
  }

  async deleteIconGroup(id: number, user: User): Promise<void> {
    const group = await this.getOwnedIconGroup(id, user);
    const activeBinding = await this.skuConfigRepository.findOne({ where: { iconGroupId: id } });
    if (activeBinding) {
      throw new BadRequestException('该图标组仍被 SKU 配置引用，请先解除绑定');
    }
    group.isActive = false;
    await this.iconGroupRepository.save(group);
  }

  async listIconKv(user: User, query: QueryIconKvDto): Promise<PaginatedResponse<IconKv>> {
    const page = query.page && query.page > 0 ? Number(query.page) : 1;
    const limit = query.limit && query.limit > 0 ? Number(query.limit) : 20;
    const skip = (page - 1) * limit;
    const queryBuilder = this.iconKvRepository.createQueryBuilder('kv')
      .leftJoinAndSelect('kv.group', 'group')
      .where('kv.isActive = :isActive', { isActive: true })
      .orderBy('kv.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (!user.isAdmin) {
      queryBuilder.andWhere('kv.userId = :userId', { userId: user.id });
    }

    if (query.groupId) {
      queryBuilder.andWhere('kv.groupId = :groupId', { groupId: query.groupId });
    }

    if (query.search?.trim()) {
      queryBuilder.andWhere('kv.name ILIKE :search', { search: `%${query.search.trim()}%` });
    }

    const [items, total] = await queryBuilder.getManyAndCount();
    return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async createIconKv(user: User, dto: CreateIconKvDto, file: Express.Multer.File): Promise<IconKv> {
    let groupId: number | null = null;
    let group: IconGroup | null = null;

    if (dto.groupId) {
      group = await this.getOwnedIconGroup(dto.groupId, user);
      groupId = group.id;
    }

    if (!file) {
      throw new BadRequestException('请上传图标文件');
    }

    // 检查同一组内是否有重复名称，如果有则自动添加后缀
    let iconName = dto.name.trim();
    if (groupId) {
      const existingIcon = await this.iconKvRepository.findOne({
        where: { groupId, name: iconName, isActive: true }
      });

      if (existingIcon) {
        // 查找可用的后缀数字
        let suffix = 1;
        let newName = `${iconName} (${suffix})`;

        while (await this.iconKvRepository.findOne({
          where: { groupId, name: newName, isActive: true }
        })) {
          suffix++;
          newName = `${iconName} (${suffix})`;
        }

        iconName = newName;
      }
    }

    const filePath = `/uploads/baskets/icons/${file.filename}`;
    const entity = this.iconKvRepository.create({
      userId: user.id,
      groupId,
      group,
      name: iconName,
      fileName: file.originalname,
      filePath,
      mimeType: file.mimetype,
      code: dto.code?.trim() || null,
      aliases: this.parseAliases(dto.aliases),
      kind: dto.kind === 'flower' ? 'flower' : 'large',
      isActive: true,
    });
    return this.iconKvRepository.save(entity);
  }

  async updateIconKv(id: number, user: User, dto: UpdateIconKvDto): Promise<IconKv> {
    const kv = await this.getOwnedIconKv(id, user);
    if (dto.groupId !== undefined) {
      if (dto.groupId === null) {
        kv.groupId = null;
        kv.group = null;
      } else {
        const group = await this.getOwnedIconGroup(dto.groupId, user);
        kv.groupId = group.id;
        kv.group = group;
      }
    }
    if (dto.name !== undefined) kv.name = dto.name.trim();
    if (dto.code !== undefined) kv.code = dto.code?.trim() || null;
    if (dto.aliases !== undefined) kv.aliases = this.parseAliases(dto.aliases);
    if (dto.kind !== undefined) kv.kind = dto.kind === 'flower' ? 'flower' : 'large';
    return this.iconKvRepository.save(kv);
  }

  /** 别名：数组，或用逗号 / 换行分隔的字符串 */
  private parseAliases(value: any): string[] | null {
    if (value === undefined || value === null || value === '') return null;
    const list = Array.isArray(value) ? value : String(value).split(/[,，\n]/);
    const cleaned = Array.from(new Set(list.map((v) => String(v).trim()).filter(Boolean)));
    return cleaned.length ? cleaned : null;
  }

  async deleteIconKv(id: number, user: User): Promise<void> {
    const kv = await this.getOwnedIconKv(id, user);
    kv.isActive = false;
    await this.iconKvRepository.save(kv);
  }

  async deleteIconKvBatch(ids: number[], user: User): Promise<{ deletedIds: number[] }> {
    if (!ids?.length) {
      throw new BadRequestException('请选择要删除的图标字典项');
    }

    const deletedIds: number[] = [];
    for (const id of ids) {
      const kv = await this.getOwnedIconKv(id, user);
      kv.isActive = false;
      await this.iconKvRepository.save(kv);
      deletedIds.push(id);
    }

    return { deletedIds };
  }

  async getActiveColorGroups(user: User): Promise<ColorGroup[]> {
    return this.colorGroupRepository.find({ where: { userId: user.id, isActive: true }, order: { name: 'ASC' } });
  }

  async getActiveIconGroups(user: User): Promise<IconGroup[]> {
    return this.iconGroupRepository.find({ where: { userId: user.id, isActive: true }, order: { name: 'ASC' } });
  }

  private async validateSkuConfigReferences(userId: string, configDto: Partial<CreateSkuConfigDto>): Promise<void> {
    if (configDto.colorGroupId) {
      const group = await this.colorGroupRepository.findOne({ where: { id: configDto.colorGroupId, userId, isActive: true } });
      if (!group) throw new BadRequestException(`颜色组 ${configDto.colorGroupId} 不存在或无权限访问`);
    }

    if (configDto.iconGroupId) {
      const group = await this.iconGroupRepository.findOne({ where: { id: configDto.iconGroupId, userId, isActive: true } });
      if (!group) throw new BadRequestException(`图标组 ${configDto.iconGroupId} 不存在或无权限访问`);
    }

    if (configDto.iconLayoutTemplateId) {
      const template = await this.templateRepository.findOne({ where: { id: configDto.iconLayoutTemplateId, isActive: true } });
      if (!template || (template.userId !== userId)) throw new BadRequestException(`图标布局模板 ${configDto.iconLayoutTemplateId} 不存在或无权限访问`);
    }
    this.validateNameLayout(configDto.nameLayout as any, 'SKU');
    if (configDto.produceMode && !['ppt', 'external', 'ignore'].includes(configDto.produceMode)) {
      throw new BadRequestException('生成方式只能是 ppt / external / ignore');
    }

    if (configDto.comboOverridesJson) {
      const comboItems = new Set((configDto.comboItems || []).map((item) => String(item).trim()).filter(Boolean));
      for (const [key, value] of Object.entries(configDto.comboOverridesJson)) {
        if (comboItems.size > 0 && !comboItems.has(key)) {
          throw new BadRequestException(`子 SKU 覆盖项 ${key} 不在 comboItems 中`);
        }
        if (!value || Object.values(value).every((item) => item === undefined || item === null || item === '')) {
          throw new BadRequestException(`子 SKU 覆盖项 ${key} 至少需要一个有效字段`);
        }
        if (value.colorGroupId) {
          const group = await this.colorGroupRepository.findOne({ where: { id: value.colorGroupId, userId, isActive: true } });
          if (!group) throw new BadRequestException(`子 SKU ${key} 绑定的颜色组不存在或无权限访问`);
        }
        if (value.iconGroupId) {
          const group = await this.iconGroupRepository.findOne({ where: { id: value.iconGroupId, userId, isActive: true } });
          if (!group) throw new BadRequestException(`子 SKU ${key} 绑定的图标组不存在或无权限访问`);
        }
        if ((value as any).iconLayoutTemplateId) {
          const template = await this.templateRepository.findOne({ where: { id: (value as any).iconLayoutTemplateId, isActive: true } });
          if (!template || template.userId !== userId) throw new BadRequestException(`子 SKU ${key} 的图标布局模板不存在或无权限访问`);
        }
        this.validateNameLayout((value as any).nameLayout, `子 SKU ${key}`);
      }
    }
  }

  private validateNameLayout(layout: any, label: string) {
    if (!layout) return;
    const area = layout.area;
    if (area) {
      const nums = ['x1', 'x2', 'y1', 'y2'].map((k) => Number(area[k]));
      if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 100) || nums[0] >= nums[1] || nums[2] >= nums[3]) {
        throw new BadRequestException(`${label} 的名字区域无效：需要 0 ≤ x1 < x2 ≤ 100、0 ≤ y1 < y2 ≤ 100（百分比）`);
      }
    }
    for (const k of ['maxFontSize', 'minFontSize', 'preferredFontSize', 'bufferPt', 'maxLatinLetters']) {
      if (layout[k] !== undefined && layout[k] !== null && !(Number(layout[k]) >= 0)) throw new BadRequestException(`${label} 的 ${k} 必须是非负数`);
    }
    if (layout.minFontSize && layout.maxFontSize && Number(layout.minFontSize) > Number(layout.maxFontSize)) {
      throw new BadRequestException(`${label} 的最小字号不能大于最大字号`);
    }
  }

  private async getOwnedColorGroup(id: number, user: User): Promise<ColorGroup> {
    const group = await this.colorGroupRepository.findOne({ where: user.isAdmin ? { id, isActive: true } : { id, userId: user.id, isActive: true } });
    if (!group) throw new NotFoundException(`颜色组 ${id} 不存在`);
    return group;
  }

  private async getOwnedColorKv(id: number, user: User): Promise<ColorKv> {
    const kv = await this.colorKvRepository.findOne({ where: { id, isActive: true }, relations: ['group'] });
    if (!kv) throw new NotFoundException(`颜色词条 ${id} 不存在`);
    if (!user.isAdmin) {
      const ownedByGroup = kv.group?.userId === user.id;
      const ownedBySelf = kv.userId === user.id;
      if (!ownedByGroup && !ownedBySelf) {
        throw new NotFoundException(`颜色词条 ${id} 不存在`);
      }
    }
    return kv;
  }

  private async getOwnedIconGroup(id: number, user: User): Promise<IconGroup> {
    const group = await this.iconGroupRepository.findOne({ where: user.isAdmin ? { id, isActive: true } : { id, userId: user.id, isActive: true } });
    if (!group) throw new NotFoundException(`图标组 ${id} 不存在`);
    return group;
  }

  private normalizeColorValue(colorValueRaw: string): string {
    const colorValue = colorValueRaw?.trim();
    if (!colorValue) {
      throw new BadRequestException('颜色映射值不能为空');
    }
    return colorValue;
  }

  private async getOwnedIconKv(id: number, user: User): Promise<IconKv> {
    const kv = await this.iconKvRepository.findOne({ where: { id, isActive: true }, relations: ['group'] });
    if (!kv) throw new NotFoundException(`图标词条 ${id} 不存在`);
    if (!user.isAdmin) {
      const ownedByGroup = kv.group?.userId === user.id;
      const ownedBySelf = kv.userId === user.id;
      if (!ownedByGroup && !ownedBySelf) {
        throw new NotFoundException(`图标词条 ${id} 不存在`);
      }
    }
    return kv;
  }

  private emptyBindingSummary(): GroupBindingSummary {
    return { boundSkuCount: 0, boundSkus: [] };
  }

  private async getGroupBindingSummary(groupType: 'color' | 'icon', groupId: number): Promise<GroupBindingSummary> {
    const summaries = await this.getGroupBindingSummaries(groupType, [groupId]);
    return summaries.get(groupId) || this.emptyBindingSummary();
  }

  private async getGroupBindingSummaries(groupType: 'color' | 'icon', groupIds: number[]): Promise<Map<number, GroupBindingSummary>> {
    const summaryMap = new Map<number, GroupBindingSummary>();

    if (!groupIds.length) {
      return summaryMap;
    }

    const bindingField = groupType === 'color' ? 'colorGroupId' : 'iconGroupId';
    const configs = await this.skuConfigRepository.find({
      where: {
        [bindingField]: In(groupIds),
      } as any,
      select: ['id', 'sku', 'colorGroupId', 'iconGroupId'],
      order: { sku: 'ASC' },
    });

    for (const groupId of groupIds) {
      summaryMap.set(groupId, this.emptyBindingSummary());
    }

    for (const config of configs) {
      const targetId = groupType === 'color' ? config.colorGroupId : config.iconGroupId;
      if (!targetId) {
        continue;
      }

      const summary = summaryMap.get(targetId) || this.emptyBindingSummary();
      summary.boundSkus.push(config.sku);
      summary.boundSkuCount = summary.boundSkus.length;
      summaryMap.set(targetId, summary);
    }

    return summaryMap;
  }

  /**
   * Helper method to safely clean up a file
   * @param filePath File path to clean up
   */
  private safeDeleteFile(filePath: string | null): void {
    if (!filePath) {
      return; // Skip if path is null or undefined
    }
    
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.debug(`Successfully deleted file: ${filePath}`);
      } else {
        this.logger.debug(`File not found, cannot delete: ${filePath}`);
      }
    } catch (error) {
      this.logger.warn(`Failed to delete file: ${filePath}`, error.message);
    }
  }

  private getPhysicalFilePath(filePath?: string | null): string | null {
    if (!filePath) {
      return null;
    }

    const trimmedPath = filePath.trim();
    if (!trimmedPath) {
      return null;
    }

    if (trimmedPath.startsWith(process.cwd())) {
      return trimmedPath;
    }

    if (trimmedPath.startsWith('/uploads')) {
      return path.join(process.cwd(), trimmedPath.substring(1));
    }

    if (path.isAbsolute(trimmedPath)) {
      return trimmedPath;
    }

    return path.join(process.cwd(), trimmedPath);
  }

  private ensureJobNotCancelled(jobId?: string): void {
    if (!jobId) {
      return;
    }

    if (this.jobQueueService.isCancelRequested(jobId)) {
      const jobProgress = this.jobQueueService.getJobProgress(jobId);
      const message = jobProgress?.cancelReason || jobProgress?.message || '订单文件生成任务已取消';
      throw new JobCancelledError(message);
    }
  }

  /**
   * 后台处理上传的 Excel（v2）：明细落库 → 规则解析 → 布局计划 → 连单核对 → 渲染 → 打包。
   * 具体流程见 BasketLinesService / pipeline/*。
   */
  private async processBasketOrdersAsync(
    recordId: number,
    file: Express.Multer.File,
    jobId: string,
    user: User,
    orderType: BasketUploadOrderType
  ): Promise<void> {
    const progress = async (value: number, message: string) => {
      this.ensureJobNotCancelled(jobId);
      await this.basketRecordRepository.update(recordId, { progress: value });
      this.jobQueueService.updateJobProgress(jobId, { status: 'processing', progress: value, message });
    };
    try {
      const recordEntity = await this.basketRecordRepository.findOne({ where: { id: recordId }, relations: ['user'] });
      if (!recordEntity) {
        throw new NotFoundException(`Record with ID ${recordId} not found`);
      }
      await this.basketRecordRepository.update(recordId, { status: 'processing', progress: 10, sourceFilePath: file.path });
      await progress(10, '开始处理Excel文件');

      const owner = recordEntity.user || user;
      const { output, webPath } = await this.basketLinesService.generateFromExcel(
        recordEntity,
        file.path,
        { ...owner, isAdmin: user.isAdmin } as User,
        orderType,
        (value, message) => {
          progress(value, message).catch(() => undefined);
        },
      );
      this.ensureJobNotCancelled(jobId);

      if (!webPath) {
        const exceptions = output.stats.exceptionLines;
        throw new Error(
          output.stats.linesTotal === 0
            ? 'Excel 里没有读到任何订单行'
            : `没有生成任何制作页（${output.stats.linesTotal} 行明细，其中 ${exceptions} 行进入异常清单），请在"母婴明细 / 异常清单"中查看原因`,
        );
      }

      const stats = this.basketLinesService.recordStats(output);
      await this.basketRecordRepository.update(recordId, {
        status: 'completed',
        progress: 100,
        outputFilePath: webPath,
        errorMessage: output.stats.exceptionLines ? `${output.stats.exceptionLines} 行进入异常清单` : null,
        ...stats,
      });

      this.jobQueueService.updateJobProgress(jobId, {
        status: 'completed',
        progress: 100,
        message: `${ORDER_TYPE_LABELS[orderType] || ''}订单文件生成成功：${output.stats.unitsProduced} 个制作单元${output.stats.exceptionLines ? `，${output.stats.exceptionLines} 行异常待处理` : ''}`,
        result: {
          filePath: webPath,
          totalOrders: output.stats.unitsProduced,
          fileType: 'zip',
          containsPpt: true,
          containsExcel: true,
          orderType,
          recordId,
          exceptionLines: output.stats.exceptionLines,
          linesTotal: output.stats.linesTotal,
        },
      });
      this.logger.log(`Successfully generated order package for record #${recordId}`);
      this.jobQueueService.startJobCleanup(jobId, 3 * 60 * 60 * 1000);
    } catch (error) {
      if (error instanceof JobCancelledError) {
        this.logger.warn(`Job ${jobId} cancelled while processing record #${recordId}: ${error.message}`);
        await this.basketRecordRepository.update(recordId, {
          status: 'cancelled',
          progress: 0,
          errorMessage: error.message,
          outputFilePath: null,
        });
        this.jobQueueService.markJobCancelled(jobId, { message: error.message, progress: 0 });
        this.jobQueueService.startJobCleanup(jobId, 60 * 60 * 1000);
        return;
      }

      this.logger.error(`Error generating order package for record #${recordId}: ${error.message}`);
      await this.basketRecordRepository.update(recordId, {
        status: 'failed',
        progress: 0,
        errorMessage: error.message,
      });
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'failed',
        progress: 0,
        message: `订单文件生成失败 (${ORDER_TYPE_LABELS[orderType] || orderType})`,
        error: error.message,
      });
      this.jobQueueService.startJobCleanup(jobId, 60 * 60 * 1000);
    }
  }

  /**
   * 应用日期过滤器
   * @param queryBuilder 查询构建器
   * @param startDate 开始日期
   * @param endDate 结束日期
   */
  private applyDateFilters(queryBuilder, startDate?: string, endDate?: string) {
    if (startDate && endDate) {
      // 如果提供了开始和结束日期，过滤这个日期范围内的记录
      queryBuilder.andWhere('record.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: new Date(`${endDate}T23:59:59Z`),
      });
    } else if (startDate) {
      // 如果只提供了开始日期，过滤晚于该日期的记录
      queryBuilder.andWhere('record.createdAt >= :startDate', {
        startDate: new Date(`${startDate}T00:00:00Z`),
      });
    } else if (endDate) {
      // 如果只提供了结束日期，过滤早于该日期的记录
      queryBuilder.andWhere('record.createdAt <= :endDate', {
        endDate: new Date(`${endDate}T23:59:59Z`),
      });
    }
  }

  /**
   * Get generation record by ID
   * @param id Generation record ID
   * @param user Current user
   * @returns Basket generation record
   */
  async getGenerationRecord(id: number, user: User): Promise<BasketGenerationRecord> {
    const record = await this.basketRecordRepository.findOne({ 
      where: { id },
      relations: ['user']
    });

    if (!record) {
      throw new NotFoundException(`Record with ID ${id} not found`);
    }

    // Check if user has access to this record
    if (!user.isAdmin && record.userId !== user.id) {
      throw new ForbiddenException('You do not have permission to access this record');
    }

    return record;
  }

  async deleteGenerationRecord(id: number, user: User): Promise<void> {
    const record = await this.getGenerationRecord(id, user);

    if (record.status === 'processing' || record.status === 'pending') {
      throw new BadRequestException('任务正在进行中，请先取消任务后再删除记录');
    }

    const physicalPath = this.getPhysicalFilePath(record.outputFilePath);
    this.safeDeleteFile(physicalPath);

    await this.basketRecordRepository.delete(id);
  }

  async deleteGenerationRecords(ids: number[], user: User): Promise<{ deleted: number[]; failed: { id: number; reason: string }[] }> {
    const deleted: number[] = [];
    const failed: { id: number; reason: string }[] = [];

    for (const id of ids) {
      try {
        await this.deleteGenerationRecord(id, user);
        deleted.push(id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : '未知错误';
        failed.push({ id, reason });
      }
    }

    return { deleted, failed };
  }

  async cancelGenerationRecord(id: number, user: User): Promise<{ success: boolean; message: string }> {
    const record = await this.getGenerationRecord(id, user);

    if (record.status === 'completed') {
      throw new BadRequestException('任务已完成，无法取消');
    }

    if (record.status === 'failed') {
      throw new BadRequestException('任务已失败，无需取消');
    }

    if (record.status === 'cancelled') {
      return { success: true, message: '任务已取消' };
    }

    if (!record.jobId) {
      await this.basketRecordRepository.update(id, {
        status: 'cancelled',
        progress: 0,
        errorMessage: '任务取消成功'
      });
      return { success: true, message: '任务取消成功' };
    }

    const requested = this.jobQueueService.requestCancel(record.jobId, '任务已发起取消');

    if (requested) {
      await this.basketRecordRepository.update(id, {
        status: 'cancelled',
        progress: record.progress ?? 0,
        errorMessage: '任务取消中'
      });
      return { success: true, message: '任务取消中' };
    }

    return { success: false, message: '任务已无法取消或已完成' };
  }

  /**
   * Get all generation records with pagination
   * @param paginationDto pagination parameters
   * @param user Current user
   * @returns Paginated list of basket generation records
   */
  async getAllGenerationRecords(
    paginationDto: BasketPaginationDto,
    user: User
  ): Promise<PaginatedResponse<BasketGenerationRecord>> {
    const { page = 1, limit = 10, search, status, startDate, endDate } = paginationDto;
    const skip = (page - 1) * limit;

    // Create query builder
    const queryBuilder = this.basketRecordRepository.createQueryBuilder('record')
      .leftJoinAndSelect('record.user', 'user')
      .orderBy('record.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    // Apply status filter if provided
    if (status) {
      queryBuilder.andWhere('record.status = :status', { status });
    }

    // Apply date filters
    this.applyDateFilters(queryBuilder, startDate, endDate);

    // Apply search filter if provided: fuzzy match filename/orderIds/skus
    if (search) {
      queryBuilder.andWhere(
        'record.originalFilename ILIKE :term OR record."orderIds"::text ILIKE :term OR record."skus"::text ILIKE :term',
        { term: `%${search}%` }
      );
    }

    // Apply user filter based on role
    if (!user.isAdmin) {
      // Regular users can only see their own records
      queryBuilder.andWhere('record.userId = :userId', { userId: user.id });
    }

    // Get results with count
    const [items, total] = await queryBuilder.getManyAndCount();

    // Return paginated response
    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Search generation records by orderId and optional sku
   * @param params search parameters
   * @param user Current user
   */
  async searchGenerationRecords(
    params: { orderId?: string; sku?: string; page?: number; limit?: number },
    user: User
  ): Promise<PaginatedResponse<BasketGenerationRecord>> {
    const { orderId, sku, page = 1, limit = 10 } = params;
    const skip = (page - 1) * limit;

    const queryBuilder = this.basketRecordRepository.createQueryBuilder('record')
      .leftJoinAndSelect('record.user', 'user')
      .orderBy('record.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (orderId) {
      queryBuilder.andWhere(':orderId = ANY(record.orderIds)', { orderId: String(orderId) });
    }

    if (sku) {
      queryBuilder.andWhere(':sku = ANY(record.skus)', { sku: String(sku) });
    }

    if (!user.isAdmin) {
      queryBuilder.andWhere('record.userId = :userId', { userId: user.id });
    }

    const [items, total] = await queryBuilder.getManyAndCount();

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Check the status of a basket generation job
   * @param jobId Job ID from job queue
   * @param user Current user
   * @returns Job progress information
   */
  async checkJobStatus(jobId: string, user: User): Promise<any> {
    const jobProgress = this.jobQueueService.getJobProgress(jobId);
    
    if (!jobProgress) {
      throw new NotFoundException(`Job with ID ${jobId} not found`);
    }
    
    // Check if job belongs to user (unless admin)
    if (!user.isAdmin && jobProgress.userId && jobProgress.userId !== user.id) {
      throw new NotFoundException(`Job with ID ${jobId} not found`);
    }
    
    // Format the response for the client
    const response: any = {
      status: jobProgress.status,
      progress: jobProgress.progress,
      message: jobProgress.message
    };
    
    // Add result if available
    if (jobProgress.result) {
      // Ensure filePath is in the web-accessible format
      let filePath = jobProgress.result.filePath;
      
      // If path doesn't start with /uploads, transform it
      if (filePath && !filePath.startsWith('/uploads')) {
        const fileName = path.basename(filePath);
        filePath = `/uploads/baskets/${fileName}`;
        this.logger.debug(`Transformed file path for web access: ${filePath}`);
      }
      
      response.result = {
        ...jobProgress.result,
        filePath,
        isZipFile: filePath && filePath.endsWith('.zip')
      };

      // If this is a completed job, update the response to match BasketGenerationResponseDto format
      if (jobProgress.status === 'completed') {
        response.output = {
          zipPath: filePath,
          totalOrders: jobProgress.result.totalOrders || 0
        };
      }
    }
    
    // Add error if available
    if (jobProgress.error) {
      response.error = jobProgress.error;
    }
    
    return response;
  }
} 
