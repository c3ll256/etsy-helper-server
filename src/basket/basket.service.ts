import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository, Not } from 'typeorm';
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
import { BasketGenerationResponseDto } from './dto/basket-generation-response.dto';
import { User } from '../users/entities/user.entity';
import { BasketPaginationDto } from './dto/basket-pagination.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { JobQueueService } from '../common/services/job-queue.service';
import { SkuConfig } from './entities/sku-config.entity';
import { CreateSkuConfigDto, BatchUpdateSkuConfigItemDto } from './dto/sku-config.dto';
import { AliyunService } from 'src/common/services/aliyun.service';
import { RemoteAreaService } from 'src/common/services/remote-area.service';
import { ColorGroup } from './entities/color-group.entity';
import { ColorKv } from './entities/color-kv.entity';
import { IconGroup } from './entities/icon-group.entity';
import { IconKv } from './entities/icon-kv.entity';
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

interface ParsedVariation {
  color: string;
  value: string;
  icon?: string;
  design?: string;
  originalText?: string;
  iconFilePath?: string;
}

interface ResolvedComboOverride {
  fontSize?: number;
  colorGroupId?: number;
  iconGroupId?: number;
  colorMap?: Record<string, string>;
  iconMap?: Record<string, string>;
}

interface ProcessedOrder {
  id: number;
  quantity: number;
  orderId: string;
  shipName: string;
  variations: ParsedVariation[];
  sku: string; // replaced SKU for PPT
  originalSku: string; // original SKU from import Excel for export
  orderType?: 'basket' | 'backpack' | 'combo';
  fontSize?: number;
  font?: string;
  rawVariations?: ParsedVariation[];
  colorGroupId?: number | null;
  iconGroupId?: number | null;
  baseColorMap?: Record<string, string>;
  baseIconMap?: Record<string, string>;
  comboOverrides?: Record<string, ResolvedComboOverride>;
  datePaid?: string;
  orderDate?: string;
  isRemoteArea?: boolean;
  shipAddress?: string;
  // combo specific
  comboItems?: string[];
  // external order reminder
  externalOrderReminderEnabled?: boolean;
  externalOrderReminderContent?: string;
}

class JobCancelledError extends Error {
  constructor(message?: string) {
    super(message || '订单文件生成任务已取消');
    this.name = 'JobCancelledError';
  }
}

@Injectable()
export class BasketService {
  private readonly logger = new Logger(BasketService.name);
  private readonly uploadsDir = 'uploads/baskets';

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
    private readonly pythonBasketService: PythonBasketService,
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
    orderType: 'basket' | 'backpack' | 'all' = 'basket'
  ): Promise<BasketGenerationResponseDto> {
    // Check if user has SKU configuration
    const findOptions: any = {
      where: { userId: user.id },
      order: { createdAt: 'DESC' }
    };

    // Filter configs by type if orderType is specific
    if (orderType === 'basket' || orderType === 'backpack') {
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
    this.processBasketOrdersAsync(savedRecord.id, file, jobId, userConfigs, orderType);

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
    options: { page: number; limit: number; search?: string }
  ): Promise<PaginatedResponse<SkuConfig>> {
    const { page = 1, limit = 10, search } = options;
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

        // Check if there are any fields to update
        if (Object.keys(updateFields).length === 0) {
          errors.push({ id, reason: '没有提供任何要更新的字段' });
          continue;
        }

        await this.validateSkuConfigReferences(userId, {
          sku: updateFields.sku ?? config.sku,
          type: updateFields.type ?? config.type,
          replaceValue: updateFields.replaceValue ?? config.replaceValue,
          fontSize: updateFields.fontSize ?? config.fontSize,
          font: updateFields.font ?? config.font,
          yarnColorMap: updateFields.yarnColorMap ?? config.yarnColorMap,
          comboItems: (updateFields.comboItems ?? config.comboItems) as string[] | undefined,
          colorGroupId: updateFields.colorGroupId ?? config.colorGroupId,
          iconGroupId: updateFields.iconGroupId ?? config.iconGroupId,
          comboOverridesJson: (updateFields.comboOverridesJson ?? config.comboOverridesJson) as any,
          externalOrderReminderEnabled: updateFields.externalOrderReminderEnabled ?? config.externalOrderReminderEnabled,
          externalOrderReminderContent: updateFields.externalOrderReminderContent ?? config.externalOrderReminderContent,
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
    return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
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
    return this.colorGroupRepository.save(group);
  }

  async getColorGroup(id: number, user: User): Promise<ColorGroup> {
    return this.getOwnedColorGroup(id, user);
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

    await this.ensureUniqueColorValueInGroup(user, groupId, dto.colorValue);

    const entity = this.colorKvRepository.create({
      userId: user.id,
      groupId,
      name: dto.name.trim(),
      colorValue: dto.colorValue.trim(),
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

    const normalizedValues = dto.items
      .map((item) => item.colorValue?.trim())
      .filter(Boolean);
    const duplicatedInPayload = normalizedValues.find((value, index) => normalizedValues.indexOf(value) !== index);
    if (duplicatedInPayload) {
      throw new BadRequestException(`同一颜色组内颜色值不可重复：${duplicatedInPayload}`);
    }

    for (const item of dto.items) {
      await this.ensureUniqueColorValueInGroup(user, groupId, item.colorValue);
    }

    const entities = dto.items.map((item) => this.colorKvRepository.create({
      userId: user.id,
      groupId,
      name: item.name.trim(),
      colorValue: item.colorValue.trim(),
      isActive: true,
    }));

    return this.colorKvRepository.save(entities);
  }

  async updateColorKv(id: number, user: User, dto: UpdateColorKvDto): Promise<ColorKv> {
    const kv = await this.getOwnedColorKv(id, user);
    let nextGroupId = kv.groupId ?? null;
    if (dto.groupId !== undefined) {
      if (dto.groupId === null) {
        kv.groupId = null;
        kv.group = null;
        nextGroupId = null;
      } else {
        const group = await this.getOwnedColorGroup(dto.groupId, user);
        kv.groupId = group.id;
        kv.group = group;
        nextGroupId = group.id;
      }
    }
    if (dto.name !== undefined) kv.name = dto.name.trim();
    if (dto.colorValue !== undefined) {
      await this.ensureUniqueColorValueInGroup(user, nextGroupId, dto.colorValue, kv.id);
      kv.colorValue = dto.colorValue.trim();
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
    return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
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
    return this.getOwnedIconGroup(id, user);
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
    return this.iconKvRepository.save(kv);
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
      }
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

  private async ensureUniqueColorValueInGroup(user: User, groupId: number | null, colorValueRaw: string, excludeId?: number): Promise<void> {
    const colorValue = colorValueRaw?.trim();
    if (!colorValue) {
      throw new BadRequestException('颜色映射值不能为空');
    }

    const qb = this.colorKvRepository.createQueryBuilder('kv')
      .leftJoinAndSelect('kv.group', 'group')
      .where('kv.isActive = :isActive', { isActive: true })
      .andWhere('kv.colorValue = :colorValue', { colorValue });

    if (groupId === null) {
      qb.andWhere('kv.groupId IS NULL');
    } else {
      qb.andWhere('kv.groupId = :groupId', { groupId });
    }

    if (excludeId) {
      qb.andWhere('kv.id != :excludeId', { excludeId });
    }

    if (!user.isAdmin) {
      qb.andWhere('(kv.userId = :userId OR group.userId = :userId)', { userId: user.id });
    }

    const existed = await qb.getOne();
    if (existed) {
      throw new BadRequestException(`同一颜色组内颜色值不可重复：${colorValue}`);
    }
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

  /**
   * Determine order type based on SKU and user configuration
   * @param sku SKU from Excel
   * @param skuConfigs User's SKU configurations
   * @returns Order type ('basket', 'backpack', or undefined if no match)
   */
  private determineOrderType(sku: string, skuConfigs: SkuConfig[]): 'basket' | 'backpack' | 'combo' | undefined {
    if (!sku) return undefined;
    
    // 使用模糊匹配，只要配置的 SKU 是订单 SKU 的一部分就匹配
    const matchingConfig = skuConfigs.find(config => sku.includes(config.sku));
    if (matchingConfig) {
      return matchingConfig.type as any;
    }
    
    return undefined;
  }

  /**
   * Process Excel file to extract order data
   * @param excelBuffer Buffer containing Excel data
   * @param skuConfigs User's SKU configurations
   * @returns Array of processed order data
   */
  private async processExcelData(excelBuffer: Buffer, skuConfigs: SkuConfig[]): Promise<ProcessedOrder[]> {
    try {
      // Read the Excel file
      const workbook = read(excelBuffer, { type: 'buffer' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = utils.sheet_to_json(worksheet);
      
      this.logger.log(`Processing ${rawData.length} rows from Excel file`);
      
      const processedOrders: ProcessedOrder[] = [];
      const colorGroupCache = new Map<number, Record<string, string>>();
      const iconGroupCache = new Map<number, Record<string, string>>();
      
      // Process each row
      for (let i = 0; i < rawData.length; i++) {
        const row = rawData[i];
        
        try {
          this.logger.debug(`Processing row ${i + 1}: ${JSON.stringify(row)}`);
          
          // Extract required fields
          const quantity = Number(row['Quantity'] || row['数量'] || 1);
          const orderId = row['Order ID'] || row['OrderID'] || row['订单ID'] || '';
          const shipName = row['Ship Name'] || row['收件人姓名'] || row['收件人'] || '';
          const variations = row['Variations'] || row['变量'] || '';
          const skuRaw = row['SKU'] || '';
          const datePaid = row['Date Paid'] || row['付款日期'] || '';
          const orderDate = row['Sale Date'] || row['Order Date'] || row['下单日期'] || row['下单时间'] || '';
          const shipState = row['Ship State'] || row['省/州'] || '';
          const shipAddress1 = row['Ship Address 1'] || row['地址1'] || '';
          const shipAddress2 = row['Ship Address 2'] || row['地址2'] || '';
          const shipCity = row['Ship City'] || row['城市'] || '';
          const shipZip = row['Ship Zip'] || row['邮编'] || '';
          const shipCountry = row['Ship Country'] || row['国家'] || '';
          
          // 使用dayjs格式化日期
          const formattedDatePaid = this.formatExcelDate(datePaid);
          const formattedOrderDate = this.formatExcelDate(orderDate);
          
          // Determine order type based on SKU
          const orderType = this.determineOrderType(skuRaw, skuConfigs);

          // If neither basket nor backpack SKU is matched, skip this order
          if (!orderType) {
            this.logger.debug(`Skipping row ${i + 1}: SKU ${skuRaw} does not match any configured patterns`);
            continue;
          }
          
          // Use LLM to analyze variations based on order type
          const analyzedVariations = await this.analyzeVariations(variations, orderType);
          
          // Find matching SKU config for replacement value and font size
          const skuConfig = skuConfigs.find(config => skuRaw.includes(config.sku));

          const baseColorMap = await this.resolveColorMapForSkuConfig(skuConfig, colorGroupCache);
          const baseIconMap = await this.resolveIconMapForSkuConfig(skuConfig, iconGroupCache);
          const comboOverrides = await this.resolveComboOverrides(skuConfig, colorGroupCache, iconGroupCache);
          
          // Replace the matched part while preserving the rest
          let replacedSku = skuRaw;
          if (skuConfig) {
            const matchedIndex = skuRaw.indexOf(skuConfig.sku);
            if (matchedIndex !== -1) {
              replacedSku = skuRaw.slice(0, matchedIndex) + 
                           skuConfig.replaceValue + 
                           skuRaw.slice(matchedIndex + skuConfig.sku.length);
            }
          }

          // Apply yarn color mapping if configured for this SKU
          const finalVariations = this.applyColorMap(analyzedVariations, baseColorMap);
          
          // 保存数据行号（注意：第一行是标题行，不包含在rawData中）
          // 因此实际的Excel行号需要加2（1是因为Excel从1开始，再加1是因为标题行）
          const excelRowIndex = i + 2;
          
          // Map the row data to our order structure
          const orderData: ProcessedOrder = {
            id: excelRowIndex, // 使用正确的Excel行号
            quantity,
            orderId,
            shipName,
            variations: finalVariations,
            rawVariations: analyzedVariations,
            sku: replacedSku,
            originalSku: skuRaw,
            orderType,
            fontSize: skuConfig?.fontSize,
            font: skuConfig?.font,
            colorGroupId: skuConfig?.colorGroupId,
            iconGroupId: skuConfig?.iconGroupId,
            baseColorMap,
            baseIconMap,
            comboOverrides,
            datePaid: formattedDatePaid,
            orderDate: formattedOrderDate,
            isRemoteArea: this.remoteAreaService.isRemoteArea(shipState),
            shipAddress: [shipAddress1, shipAddress2, shipCity, shipState, shipZip, shipCountry]
              .filter(Boolean)
              .join(', '),
            comboItems: skuConfig?.type === 'combo' ? ((skuConfig as any).comboItems || []) : undefined,
            externalOrderReminderEnabled: skuConfig?.externalOrderReminderEnabled || false,
            externalOrderReminderContent: skuConfig?.externalOrderReminderContent || undefined,
          };
          
          processedOrders.push(orderData);
        } catch (error) {
          this.logger.error(`Error processing row ${i + 1}: ${error.message}`);
        }
      }
      
      return processedOrders;
    } catch (error) {
      this.logger.error(`Error processing Excel data: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 将Excel日期转换为标准格式
   * @param excelDate Excel日期值（可能是数字或字符串）
   * @returns 格式化的日期字符串 MM/DD/YYYY
   */
  private formatExcelDate(excelDate: any): string {
    if (!excelDate) return '';
    
    try {
      // 如果是日期对象
      if (excelDate instanceof Date) {
        return dayjs(excelDate).format('YYYY年MM月DD日');
      }

      // 如果是数字或可以转换为数字的字符串
      const numDate = Number(excelDate);
      if (!isNaN(numDate) && numDate > 0) {
        // Excel 日期序列号从 1900-01-01 开始计数，但 Excel 错误地将 1900 视为闰年
        // 因此对于 1900-03-01 之后的日期，需要减去额外的一天
        const excelBaseDate = dayjs('1899-12-31');
        let serial = Math.floor(numDate);

        if (serial > 59) {
          serial -= 1; // 调整 Excel 的闰年错误（虚构的 1900-02-29）
        }

        const date = excelBaseDate.add(serial, 'day');

        // 格式化为中文日期格式
        return date.format('YYYY年MM月DD日');
      }
      
      // 处理其他已经是字符串格式的日期
      const parsedDate = dayjs(excelDate);
      if (parsedDate.isValid()) {
        return parsedDate.format('YYYY年MM月DD日');
      }
      
      // 如果无法解析，返回原始字符串
      return String(excelDate);
    } catch (error) {
      this.logger.warn(`Error formatting Excel date with dayjs: ${error.message}`, excelDate);
      return String(excelDate);
    }
  }

  private async resolveColorMapForSkuConfig(
    skuConfig: SkuConfig | undefined,
    cache: Map<number, Record<string, string>>,
  ): Promise<Record<string, string>> {
    if (!skuConfig) {
      return {};
    }

    if (skuConfig.colorGroupId) {
      return this.loadColorMapByGroupId(Number(skuConfig.colorGroupId), cache);
    }

    return skuConfig.yarnColorMap || {};
  }

  private async resolveIconMapForSkuConfig(
    skuConfig: SkuConfig | undefined,
    cache: Map<number, Record<string, string>>,
  ): Promise<Record<string, string>> {
    if (!skuConfig?.iconGroupId) {
      return {};
    }

    return this.loadIconMapByGroupId(Number(skuConfig.iconGroupId), cache);
  }

  private async resolveComboOverrides(
    skuConfig: SkuConfig | undefined,
    colorCache: Map<number, Record<string, string>>,
    iconCache: Map<number, Record<string, string>>,
  ): Promise<Record<string, ResolvedComboOverride>> {
    const overrides = skuConfig?.comboOverridesJson || {};
    const resolved: Record<string, ResolvedComboOverride> = {};

    for (const [key, value] of Object.entries(overrides || {})) {
      resolved[key] = {
        fontSize: value?.fontSize,
        colorGroupId: value?.colorGroupId,
        iconGroupId: value?.iconGroupId,
        colorMap: value?.colorGroupId ? await this.loadColorMapByGroupId(Number(value.colorGroupId), colorCache) : undefined,
        iconMap: value?.iconGroupId ? await this.loadIconMapByGroupId(Number(value.iconGroupId), iconCache) : undefined,
      };
    }

    return resolved;
  }

  private async loadColorMapByGroupId(groupId: number, cache: Map<number, Record<string, string>>): Promise<Record<string, string>> {
    if (cache.has(groupId)) {
      return cache.get(groupId)!;
    }

    const items = await this.colorKvRepository.find({ where: { groupId, isActive: true } });
    const mapped = Object.fromEntries(items.map((item) => [item.name, item.colorValue]));
    cache.set(groupId, mapped);
    return mapped;
  }

  private async loadIconMapByGroupId(groupId: number, cache: Map<number, Record<string, string>>): Promise<Record<string, string>> {
    if (cache.has(groupId)) {
      return cache.get(groupId)!;
    }

    const items = await this.iconKvRepository.find({ where: { groupId, isActive: true } });
    const mapped = Object.fromEntries(items.map((item) => [item.name, item.filePath]));
    cache.set(groupId, mapped);
    return mapped;
  }

  private applyColorMap(variations: ParsedVariation[], colorMap?: Record<string, string>): ParsedVariation[] {
    if (!variations?.length || !colorMap || Object.keys(colorMap).length === 0) {
      return variations || [];
    }

    const normalizedMap = new Map<string, string>(
      Object.entries(colorMap).map(([key, value]) => [this.normalizeDictionaryKey(key), value]),
    );

    return variations.map((variation) => {
      const color = variation?.color?.trim();
      if (!color) {
        return variation;
      }

      const mapped = normalizedMap.get(this.normalizeDictionaryKey(color));
      if (!mapped) {
        return variation;
      }

      return {
        ...variation,
        color: mapped,
      };
    });
  }

  private resolveIconFilePath(iconName?: string, iconMap?: Record<string, string>): string {
    if (!iconName || !iconMap || Object.keys(iconMap).length === 0) {
      return '';
    }

    const normalizedTarget = this.normalizeDictionaryKey(iconName);
    for (const [key, filePath] of Object.entries(iconMap)) {
      if (this.normalizeDictionaryKey(key) === normalizedTarget) {
        return filePath;
      }
    }

    return '';
  }

  private normalizeDictionaryKey(value?: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_\-]+/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '');
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
   * Process basket orders asynchronously
   * @param recordId Generation record ID
   * @param file Uploaded file
   * @param jobId Job queue ID
   * @param skuConfigs User's SKU configurations
   * @param orderType Order type (basket or backpack)
   */
  private async processBasketOrdersAsync(
    recordId: number, 
    file: Express.Multer.File, 
    jobId: string,
    skuConfigs: SkuConfig[],
    orderType: 'basket' | 'backpack' | 'all' | 'combo'
  ): Promise<void> {
    // Declare file paths outside the try block so they're available in catch block
    let modifiedExcelPath: string | null = null; // 导出的Excel文件路径
    let pptFilePath: string | null = null;
    let zipFilePath: string | null = null;
    
    try {
      const recordEntity = await this.basketRecordRepository.findOne({
        where: { id: recordId },
        relations: ['user']
      });

      if (!recordEntity) {
        throw new NotFoundException(`Record with ID ${recordId} not found`);
      }

      this.ensureJobNotCancelled(jobId);

      // Update status to processing
      await this.basketRecordRepository.update(recordId, {
        status: 'processing',
        progress: 10,
      });
      
      // Update job progress
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'processing',
        progress: 10,
        message: '开始处理Excel文件',
      });

      // Parse Excel data
      await this.basketRecordRepository.update(recordId, {
        progress: 20,
      });
      
      this.jobQueueService.updateJobProgress(jobId, {
        progress: 20,
        message: '解析Excel数据',
      });

      this.ensureJobNotCancelled(jobId);

      // Read the file from disk
      const fileBuffer = fs.readFileSync(file.path);
      
      // Process the data and keep track of processed row indices
      const processedOrders = await this.processExcelData(fileBuffer, skuConfigs);
      
      // Filter orders based on orderType, unless it's 'all'
      const filteredOrders = orderType === 'all' 
          ? processedOrders // Include all processed orders if type is 'all'
          : processedOrders.filter(order => order.orderType === orderType); // Filter by specific type otherwise
      
      this.ensureJobNotCancelled(jobId);

      // Check if any orders were found
      if (filteredOrders.length === 0) {
        let errorMessage = '';
        let errorType = '';
        
        switch (orderType) {
          case 'basket': errorType = '篮子'; break;
          case 'backpack': errorType = '书包'; break;
          case 'all': errorType = '所有'; break;
          case 'combo': errorType = '组合'; break;
          default: errorType = '所有'; break;
        }

        errorMessage = `没有找到任何与您已配置的SKU匹配的${errorType}订单，请检查您的SKU配置是否正确`;

        throw new Error(errorMessage);
      }
      
      // --- Start: Generate new Excel with required columns and QR code ---
      this.logger.debug('Generating export Excel with required columns and QR codes');

      const exportWorkbook = new ExcelJS.Workbook();
      const exportSheet = exportWorkbook.addWorksheet('订单导出');

      // Define columns (requested order + SKU + 收货地址；自定义信息展示完整原始 variations)
      const headers = [
        '订单号',
        '序号',
        '下单时间',
        '顾客姓名',
        '产品数量',
        '自定义信息',
        'SKU',
        '收货地址',
        '二维码',
        '是否识别成功',
        '店铺名'
      ];

      exportSheet.columns = [
        { header: headers[0], key: 'orderId', width: 20 },
        { header: headers[1], key: 'orderGroupIndex', width: 16 },
        { header: headers[2], key: 'orderDate', width: 18 },
        { header: headers[3], key: 'shipName', width: 18 },
        { header: headers[4], key: 'quantity', width: 12 },
        { header: headers[5], key: 'customInfo', width: 50 },
        { header: headers[6], key: 'sku', width: 20 },
        { header: headers[7], key: 'shipAddress', width: 40 },
        { header: headers[8], key: 'qrcode', width: 18 },
        { header: headers[9], key: 'recognized', width: 16 },
        { header: headers[10], key: 'shopName', width: 20 },
      ];

      // 获取记录关联的用户信息（用于店铺名）
      const shopNameForExcel = recordEntity?.user?.shopName || '';

      // 预计算每个订单号对应需要导出的总行数（用于序号标识 k/N）
      const totalRowsByOrderId = new Map<string, number>();
      for (const order of filteredOrders) {
        this.ensureJobNotCancelled(jobId);
        const orderIdKey = String(order.orderId || '');
        const factor = (order.orderType === 'combo' && Array.isArray(order.comboItems) && order.comboItems.length)
          ? order.comboItems.length
          : 1;
        const rowsForThisOrder = (order.variations?.length || 0) * factor;
        const prev = totalRowsByOrderId.get(orderIdKey) || 0;
        totalRowsByOrderId.set(orderIdKey, prev + rowsForThisOrder);
      }

      // 当前序号计数器
      const currentIndexByOrderId = new Map<string, number>();

      // Add rows (expand combo orders to N rows)
      for (const order of filteredOrders) {
        this.ensureJobNotCancelled(jobId);
        for (const variation of order.variations) {
          this.ensureJobNotCancelled(jobId);
          const recognized = !!(variation?.value && variation.value.trim() && variation.originalText && variation.value.trim() !== variation.originalText.trim());

          // 自定义信息：展示完整原始 variations 文本（来自每行原始导入）
          const fullVariations = variation?.originalText || '';

          const orderIdKey = String(order.orderId || '');
          const totalForThisOrderId = totalRowsByOrderId.get(orderIdKey) || 1;

          const addOneRow = async (skuForRow: string) => {
            const current = (currentIndexByOrderId.get(orderIdKey) || 0) + 1;
            currentIndexByOrderId.set(orderIdKey, current);
            const orderGroupIndex = `${current}/${totalForThisOrderId}`;

            exportSheet.addRow({
              orderId: orderIdKey,
              orderGroupIndex,
              orderDate: order.orderDate || '',
              shipName: order.shipName || '',
              quantity: order.quantity || 1,
              customInfo: fullVariations,
              sku: skuForRow || '',
              shipAddress: order.shipAddress || '',
              qrcode: '', // 图片稍后插入
              recognized: recognized ? '是' : '否',
              shopName: shopNameForExcel,
            });
            const addedRow = exportSheet.lastRow;
            if (addedRow) {
              addedRow.height = 80;
              // Generate QR code for orderId
              try {
                const qrBuffer = await generateQrBuffer(String(order.orderId || ''));
                const imageId = exportWorkbook.addImage({ buffer: qrBuffer, extension: 'png' });
                const rowIndex = addedRow.number;
                // Place image into the QR column
                const qrColIndex = exportSheet.getColumn('qrcode').number; // 1-based index
                // Anchor image to the cell (qr column, current row)
                exportSheet.addImage(imageId, {
                  tl: { col: qrColIndex - 1 + 0.15, row: rowIndex - 1 + 0.15 },
                  ext: { width: 80, height: 80 },
                  editAs: 'oneCell'
                });
              } catch (e) {
                this.logger.warn(`Failed to generate QR for order ${order.orderId}: ${e.message}`);
              }
            }
          };

          if (order.orderType === 'combo' && Array.isArray(order.comboItems) && order.comboItems.length) {
            for (const item of order.comboItems) {
              this.ensureJobNotCancelled(jobId);
              const combinedSku = `${order.originalSku || ''} + ${item || ''}`.trim();
              await addOneRow(combinedSku);
            }
          } else {
            await addOneRow(order.originalSku || '');
          }
        }
      }

      // Save export workbook
      const exportExcelFileName = `orders_export_${Date.now()}.xlsx`;
      modifiedExcelPath = path.join(this.uploadsDir, exportExcelFileName);
      await exportWorkbook.xlsx.writeFile(modifiedExcelPath);
      this.logger.debug(`Saved export Excel to: ${modifiedExcelPath}`);
      // --- End: Generate new Excel with required columns and QR code ---

      this.ensureJobNotCancelled(jobId);

      // Collect recognized orderIds and SKUs for search
      const recognizedOrderIds = Array.from(new Set(filteredOrders.map(o => String(o.orderId || '')).filter(Boolean)));
      const recognizedSkus = Array.from(new Set(filteredOrders.map(o => String(o.originalSku || o.sku || '')).filter(Boolean)));

      // Update progress after processing Excel data
      await this.basketRecordRepository.update(recordId, {
        progress: 50,
        ordersProcessed: filteredOrders.length,
        totalOrders: filteredOrders.length,
        orderIds: recognizedOrderIds,
        skus: recognizedSkus,
      });
      
      this.jobQueueService.updateJobProgress(jobId, {
        progress: 50,
        message: `已处理 ${filteredOrders.length} 个订单`,
      });

      // Generate PPT using Python service
      this.logger.log(`Generating PPT for ${filteredOrders.length} orders`);
      
      // Prepare data for generating PPT
      await this.basketRecordRepository.update(recordId, {
        progress: 60,
      });
      
      this.jobQueueService.updateJobProgress(jobId, {
        progress: 60,
        message: '准备生成PPT',
      });
      
      this.ensureJobNotCancelled(jobId);

      // 获取记录关联的用户信息
      const shopName = recordEntity?.user?.shopName || '';
      
      // Prepare data for PPT generation
      const pptData = this.preparePPTData(filteredOrders, shopName);
      
      // Call Python service to generate PPT
      const result = await this.pythonBasketService.generateBasketOrderPPT(
        Buffer.from(JSON.stringify(pptData)).toString('base64')
      );

      this.ensureJobNotCancelled(jobId);

      // Create zip file containing both PPT and highlighted Excel
      const zip = new AdmZip();
      const zipFileName = `order_package_${Date.now()}.zip`;
      
      // Create the physical file path (absolute)
      const physicalZipPath = path.resolve(this.uploadsDir, zipFileName);
      
      // Create the web-accessible path (starting with /uploads)
      const webAccessiblePath = `/uploads/baskets/${zipFileName}`;
      
      // Store both paths for later use
      zipFilePath = physicalZipPath;
      
      this.logger.debug(`Python service returned PPT file path: ${result.filePath}`);
      
      // Handle different path formats that might be returned from Python service
      pptFilePath = result.filePath;
      
      // Try multiple approaches to locate the file if needed
      if (!fs.existsSync(pptFilePath)) {
        const possiblePaths = [
          pptFilePath,
          path.resolve(pptFilePath),
          path.join(process.cwd(), pptFilePath),
          // Try without leading slash
          pptFilePath.startsWith('/') ? pptFilePath.substring(1) : pptFilePath,
          // Try with workspace root
          path.join(process.cwd(), pptFilePath.startsWith('/') ? pptFilePath.substring(1) : pptFilePath)
        ];
        
        // Find the first path that exists
        const existingPath = possiblePaths.find(p => fs.existsSync(p));
        if (existingPath) {
          pptFilePath = existingPath;
          this.logger.debug(`Found PPT file at: ${pptFilePath}`);
        } else {
          this.logger.error(`PPT file not found. Tried paths: ${possiblePaths.join(', ')}`);
          throw new Error(`PPT file not found. Original path: ${result.filePath}`);
        }
      }
      
      // Check if modified Excel file exists
      if (!fs.existsSync(modifiedExcelPath)) {
        this.logger.error(`Modified Excel file not found at path: ${modifiedExcelPath}`);
        throw new Error(`Modified Excel file not found at path: ${modifiedExcelPath}`);
      }
      
      // Add PPT file to zip
      const pptFileName = path.basename(pptFilePath);
      zip.addFile(pptFileName, fs.readFileSync(pptFilePath));
      
      // Add modified Excel file to zip
      const excelFileName = path.basename(modifiedExcelPath); // Use modifiedExcelPath
      zip.addFile(excelFileName, fs.readFileSync(modifiedExcelPath)); // Use modifiedExcelPath

      // Write zip file to the physical path
      zip.writeZip(physicalZipPath);
      
      await this.basketRecordRepository.update(recordId, {
        progress: 90,
      });
      
      this.jobQueueService.updateJobProgress(jobId, {
        progress: 90,
        message: '文件打包完成，更新记录',
      });

      // Update record with the web-accessible path
      await this.basketRecordRepository.update(recordId, {
        status: 'completed',
        progress: 100,
        outputFilePath: webAccessiblePath, // Use web-accessible path
        ordersProcessed: filteredOrders.length,
        totalOrders: filteredOrders.length,
        orderIds: recognizedOrderIds,
        skus: recognizedSkus,
      });
      
      // Update job progress with success result and web-accessible path
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'completed',
        progress: 100,
        message: `${orderType === 'basket' ? '篮子' : '书包'}订单文件生成成功`,
        result: {
          filePath: webAccessiblePath, // Use web-accessible path
          totalOrders: filteredOrders.length,
          fileType: 'zip',
          containsPpt: true,
          containsExcel: true,
          orderType // Include the processed order type in the result
        }
      });

      this.logger.log(`Successfully generated order package for record #${recordId}`);
      
      // Clean up temporary files using physical paths
      this.safeDeleteFile(modifiedExcelPath); // Use modifiedExcelPath
      this.safeDeleteFile(pptFilePath);
      
      // Start job cleanup after 3 hours
      this.jobQueueService.startJobCleanup(jobId, 3 * 60 * 60 * 1000);
    } catch (error) {
      if (error instanceof JobCancelledError) {
        this.logger.warn(`Job ${jobId} cancelled while processing record #${recordId}: ${error.message}`);

        const physicalModifiedExcelPath = this.getPhysicalFilePath(modifiedExcelPath);
        const physicalPptPath = this.getPhysicalFilePath(pptFilePath);
        const physicalZipPath = this.getPhysicalFilePath(zipFilePath);

        this.safeDeleteFile(physicalModifiedExcelPath);
        this.safeDeleteFile(physicalPptPath);
        this.safeDeleteFile(physicalZipPath);

        await this.basketRecordRepository.update(recordId, {
          status: 'cancelled',
          progress: 0,
          errorMessage: error.message,
          outputFilePath: null,
        });

        this.jobQueueService.markJobCancelled(jobId, {
          message: error.message,
          progress: 0,
        });

        this.jobQueueService.startJobCleanup(jobId, 60 * 60 * 1000);
        return;
      }

      this.logger.error(`Error generating order package for record #${recordId}: ${error.message}`);

      // Clean up any temporary files that might have been created
      const physicalModifiedExcelPath = this.getPhysicalFilePath(modifiedExcelPath);
      const physicalPptPath = this.getPhysicalFilePath(pptFilePath);
      const physicalZipPath = this.getPhysicalFilePath(zipFilePath);

      this.safeDeleteFile(physicalModifiedExcelPath); // Use modifiedExcelPath
      this.safeDeleteFile(physicalPptPath);
      this.safeDeleteFile(physicalZipPath);
      
      // Update record with error
      await this.basketRecordRepository.update(recordId, {
        status: 'failed',
        progress: 0,
        errorMessage: error.message,
      });
      
      // Update job progress with error
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'failed',
        progress: 0,
        message: `订单文件生成失败 (${orderType === 'all' ? '所有类型' : (orderType === 'basket' ? '篮子' : '书包')})`, // Update message
        error: error.message
      });
      
      // Start job cleanup after 1 hour for failed jobs
      this.jobQueueService.startJobCleanup(jobId, 60 * 60 * 1000);
    }
  }

  /**
   * Prepare order data for PPT generation
   * @param processedOrders Processed order data
   * @param shopName 用户店铺名称
   * @returns Formatted data for PPT generation
   */
  private preparePPTData(processedOrders: ProcessedOrder[], shopName: string = ''): any[] {
    const pptSlides = [];

    // 预计算每个订单号总页数（考虑套组展开）
    const totalSlidesByOrderId = new Map<string, number>();
    for (const order of processedOrders) {
      const orderIdKey = String(order.orderId || '');
      const factor = (order.orderType === 'combo' && Array.isArray(order.comboItems) && order.comboItems.length)
        ? order.comboItems.length
        : 1;
      const slidesForThisOrder = (order.variations?.length || 0) * factor;
      const prev = totalSlidesByOrderId.get(orderIdKey) || 0;
      totalSlidesByOrderId.set(orderIdKey, prev + slidesForThisOrder);
    }

    // 当前页计数
    const currentIndexByOrderId = new Map<string, number>();

    // 生成每页
    for (const order of processedOrders) {
      const sourceVariations = order.rawVariations || order.variations || [];
      for (let variationIndex = 0; variationIndex < sourceVariations.length; variationIndex++) {
        const variation = sourceVariations[variationIndex];
        const orderIdKey = String(order.orderId || '');
        const totalForThisOrderId = totalSlidesByOrderId.get(orderIdKey) || 1;

        const baseVariation = (order.variations || [])[variationIndex] || variation;
        const baseIconFilePath = this.resolveIconFilePath(variation.icon, order.baseIconMap);

        const base = {
          date: new Date().toLocaleDateString('zh-CN'),
          orderNumber: String(order.orderId),
          icon: variation.icon || '',
          iconFilePath: baseIconFilePath,
          recipientName: order.shipName || '',
          customName: variation.value || '',
          quantity: order.quantity || 1,
          shopName: shopName || '',
          fontSize: order.fontSize,
          font: order.font,
          originalVariations: variation.originalText || '',
          datePaid: order.datePaid || '',
          isRemoteArea: order.isRemoteArea || false,
          externalOrderReminderEnabled: order.externalOrderReminderEnabled || false,
          externalOrderReminderContent: order.externalOrderReminderContent || '',
        } as any;

        if (order.orderType === 'combo' && Array.isArray(order.comboItems) && order.comboItems.length) {
          for (const item of order.comboItems) {
            const override = order.comboOverrides?.[item];
            const comboVariation = this.applyColorMap([variation], override?.colorMap || order.baseColorMap)[0] || baseVariation;
            const comboIconFilePath = this.resolveIconFilePath(variation.icon, override?.iconMap || order.baseIconMap);
            const current = (currentIndexByOrderId.get(orderIdKey) || 0) + 1;
            currentIndexByOrderId.set(orderIdKey, current);
            const position = `${current}/${totalForThisOrderId}`;

            const slide = {
              ...base,
              color: comboVariation.color || '',
              orderType: 'combo',
              sku: `${order.sku || order.originalSku || ''} + ${item || ''}`.trim(),
              fontSize: override?.fontSize ?? order.fontSize,
              iconFilePath: comboIconFilePath,
              position,
            } as any;
            pptSlides.push(slide);
          }
        } else {
          const current = (currentIndexByOrderId.get(orderIdKey) || 0) + 1;
          currentIndexByOrderId.set(orderIdKey, current);
          const position = `${current}/${totalForThisOrderId}`;

          const slideData = {
            ...base,
            color: baseVariation.color || '',
            orderType: order.orderType || 'basket',
            sku: order.sku || '',
            position,
          } as any;
          if (order.orderType === 'backpack') slideData['backpackStyle'] = true;
          pptSlides.push(slideData);
        }
      }
    }

    this.logger.debug(`Generated ${pptSlides.length} PPT slides with shop name: ${shopName}`);
    return pptSlides;
  }

  /**
   * Use LLM to analyze variations data based on order type
   * @param variations Variations string from Excel
   * @param orderType Type of order (basket or backpack)
   * @returns Array of parsed variations
   */
  private async analyzeVariations(variations: string, orderType: 'basket' | 'backpack' | 'combo'): Promise<ParsedVariation[]> {
    try {
    const prompt = `
你是一个订单变量解析专家，需要从变量中提取客户定制的内容，用JSON数组格式返回，每个元素包含：
[
  {
    "color": 变量中提到的颜色（如毛线颜色、材料颜色等）,
    ${orderType !== 'basket' ? '"icon": 变量中提到的背包图案编号,' : ''}
    "value": 变量中客户要定制的内容（如名字、文字等）
  },
  ... // 可能还有更多定制项
]

请注意！！！
1. 不要编造任何信息，并且 100% 完整保留客户定制的内容。
2. 注意，客户的颜色定制内容一般会跟在 Yarn Color 后面，客户的信息定制内容一般以 名字, 图案编号 的格式出现在 Personalization 后面，但也有可能客户会不按格式填写

例子1：
变量 (Variations): ...Yarn Color: Cream, Personalization: Branko, zd...

返回结果: [ { "color": "Cream", "icon": "zd", "value": "Branko" } ]

例子2：
变量 (Variations): Backpack Color:Rose + Icon,Yarn Color:Mix-2,Personalization:1. Rayla, 1 2. Jack, 3

返回结果: [ { "color": "Mix-2", "icon": "1", "value": "Rayla" }, { "color": "Mix-2", "icon": "3", "value": "Jack" } ]

例子3：
变量 (Variations): Backpack Color:Rose + Icon,Yarn Color:Mix-2,Personalization:1. Rayla 2. 1 & 7 (bow and yellow flower)

返回结果: [ { "color": "Mix-2", "icon": "1 & 7 (bow and yellow flower)", "value": "Rayla" } ]

例子4：
变量 (Variations): Size:L (14.96&#39;&#39;x14.96&#39;&#39;),Yarn Color:Mix-1,Personalization:1. Adler 2. No icons, just name

返回结果: [ { "color": "Mix-1", "icon": "", "value": "Adler" } ]

例子5：
变量 (Variations): Basket Color + Size:Cream-- XL,Name Color:Purple,Personalization:Poppy

返回结果: [ { "color": "Purple", "icon": "", "value": "Poppy" } ]

3. 客户的名字一定不是阿拉伯数字！！！
4. 请确保返回有效的 JSON 格式数组！！！没有额外的文本！！！
`;

      const userPrompt = `变量 (Variations): ${variations}`;

      const result = await this.aliyunService.generateJson(userPrompt, { systemPrompt: prompt });
      
      // 为每个解析的变量添加原始文本
      result.forEach(variation => {
        variation.originalText = variations;
      });
      
      this.logger.debug(`LLM analysis result for ${orderType}: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      this.logger.error(`Error analyzing variations data with LLM for ${orderType}: ${error.message}`);
      
      // Return default value if LLM analysis fails
      return [{
        color: '',
        value: variations || '',
        originalText: variations || ''
      }];
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
