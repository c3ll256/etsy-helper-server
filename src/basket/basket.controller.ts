import { 
  Controller, 
  Post, 
  Get, 
  Param, 
  UseInterceptors, 
  UploadedFile,
  ParseIntPipe,
  BadRequestException,
  Body,
  UseGuards,
  Query,
  Put,
  Delete,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody, ApiBearerAuth, ApiQuery, ApiParam, ApiForbiddenResponse } from '@nestjs/swagger';
import { Express } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { diskStorage } from 'multer';

import { BasketService } from './basket.service';
import { BasketGenerationResponseDto } from './dto/basket-generation-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { BasketPaginationDto } from './dto/basket-pagination.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { BasketGenerationRecord } from './entities/basket-generation-record.entity';
import { CreateSkuConfigDto, SkuConfigResponseDto, BatchUpdateSkuConfigDto } from './dto/sku-config.dto';
import { SkuConfig } from './entities/sku-config.entity';
import {
  CreateColorGroupDto,
  CreateColorKvDto,
  CreateColorKvBatchDto,
  DeleteColorKvBatchDto,
  CreateIconGroupDto,
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

const BASKET_ICONS_DIR = 'uploads/baskets/icons';
if (!fs.existsSync(BASKET_ICONS_DIR)) {
  fs.mkdirSync(BASKET_ICONS_DIR, { recursive: true });
}

@ApiTags('baskets')
@Controller('baskets')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class BasketController {
  constructor(private readonly basketService: BasketService) {}

  @Post('generate')
  @ApiOperation({ summary: '生成篮子或书包订单文件包' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ 
    status: 201, 
    description: '订单文件生成任务已创建', 
    type: BasketGenerationResponseDto 
  })
  @ApiResponse({ status: 400, description: '无效的文件类型或参数' })
  @ApiResponse({ status: 401, description: '未授权' })
  @UseInterceptors(FileInterceptor('file', {
    limits: {
      fileSize: 50 * 1024 * 1024, // SECURITY: 限制Excel文件大小为50MB，防止DoS攻击
    }
  }))
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Excel文件'
        },
        originalFilename: {
          type: 'string',
          description: '原始文件名'
        },
        orderType: {
          type: 'string',
          enum: ['basket', 'backpack', 'all'],
          description: '订单类型：篮子、书包或所有已配置类型',
          default: 'basket'
        }
      }
    }
  })
  async generateBasketOrders(
    @UploadedFile() file: Express.Multer.File,
    @Body('originalFilename') originalFilename: string,
    @Body('orderType') orderType: 'basket' | 'backpack' | 'all' = 'basket',
    @CurrentUser() user: User,
  ): Promise<BasketGenerationResponseDto> {
    if (!file) {
      throw new BadRequestException('没有提供Excel文件');
    }
    
    // SECURITY: 验证文件扩展名，防止路径遍历
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ext.match(/^\.(xlsx|xls)$/)) {
      throw new BadRequestException('请上传Excel文件 (.xlsx 或 .xls)');
    }
    
    // SECURITY: 验证文件名不包含路径遍历字符
    if (file.originalname.includes('..') || file.originalname.includes('/') || file.originalname.includes('\\')) {
      throw new BadRequestException('无效的文件名');
    }
    
    return this.basketService.generateBasketOrders(file, user, originalFilename, orderType);
  }

  @Get('sku-config')
  @ApiOperation({ summary: '获取SKU配置列表' })
  @ApiResponse({ 
    status: 200, 
    description: '返回SKU配置列表',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { $ref: '#/components/schemas/SkuConfig' }
        },
        meta: {
          type: 'object',
          properties: {
            total: { type: 'number' },
            page: { type: 'number' },
            limit: { type: 'number' },
            totalPages: { type: 'number' }
          }
        }
      }
    }
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '页码，默认为1' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '每页数量，默认为10' })
  @ApiQuery({ name: 'search', required: false, type: String, description: '搜索关键词' })
  async getUserSkuConfigs(
    @CurrentUser() user: User,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
    @Query('search') search?: string,
  ): Promise<PaginatedResponse<SkuConfig>> {
    return this.basketService.getUserSkuConfigs(user, { page, limit, search });
  }

  @Post('sku-config')
  @ApiOperation({ summary: '创建新的SKU配置' })
  @ApiResponse({ status: 201, description: 'SKU配置已创建', type: SkuConfigResponseDto })
  @ApiResponse({ status: 400, description: '无效的配置数据' })
  async createSkuConfig(
    @Body() configDto: CreateSkuConfigDto,
    @CurrentUser() user: User
  ): Promise<SkuConfig> {
    return this.basketService.createSkuConfig(user.id, configDto);
  }

  @Put('sku-config/:id')
  @ApiOperation({ summary: '更新SKU配置' })
  @ApiResponse({ status: 200, description: 'SKU配置已更新', type: SkuConfigResponseDto })
  @ApiResponse({ status: 400, description: '无效的配置数据' })
  @ApiResponse({ status: 404, description: '配置未找到' })
  async updateSkuConfig(
    @Param('id', ParseIntPipe) id: number,
    @Body() configDto: CreateSkuConfigDto,
    @CurrentUser() user: User
  ): Promise<SkuConfig> {
    return this.basketService.updateSkuConfig(id, user.id, configDto);
  }

  @Delete('sku-config/:id')
  @ApiOperation({ summary: '删除SKU配置' })
  @ApiResponse({ status: 200, description: 'SKU配置已删除' })
  @ApiResponse({ status: 404, description: '配置未找到' })
  async deleteSkuConfig(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User
  ): Promise<void> {
    return this.basketService.deleteSkuConfig(id, user.id);
  }

  @Post('sku-config/batch')
  @ApiOperation({ summary: '批量更新SKU配置（只需提供id和要更新的字段，未提供的字段不会更新）' })
  @ApiResponse({ 
    status: 200, 
    description: '批量更新成功',
    schema: {
      type: 'array',
      items: { $ref: '#/components/schemas/SkuConfig' }
    }
  })
  @ApiResponse({ status: 400, description: '无效的配置数据或批量更新失败' })
  @ApiBody({
    description: '批量更新SKU配置，每个配置项只需提供id和要更新的字段',
    schema: {
      type: 'object',
      properties: {
        configs: {
          type: 'array',
          description: '配置列表，每个配置项至少需要提供id和一个要更新的字段',
          items: {
            type: 'object',
            required: ['id'],
            properties: {
              id: {
                type: 'number',
                description: '配置ID（必需）'
              },
              sku: {
                type: 'string',
                description: 'SKU编码（可选）'
              },
              type: {
                type: 'string',
                enum: ['basket', 'backpack', 'combo'],
                description: 'SKU类型（可选）'
              },
              replaceValue: {
                type: 'string',
                description: '替换后的显示文本（可选）'
              },
              fontSize: {
                type: 'number',
                description: '字体大小（可选）'
              },
              font: {
                type: 'string',
                description: '字体名称（可选）'
              },
              yarnColorMap: {
                type: 'object',
                description: 'Yarn颜色替换映射（可选）'
              },
              comboItems: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: '套组款式数组，例如 ["SKU1", "SKU2"]（可选）'
              },
              externalOrderReminderEnabled: {
                type: 'boolean',
                description: '外部订单提醒开关（可选）'
              },
              externalOrderReminderContent: {
                type: 'string',
                description: '外部订单提醒内容（可选）'
              }
            }
          }
        }
      }
    }
  })
  async batchUpdateSkuConfigs(
    @Body() batchUpdateDto: BatchUpdateSkuConfigDto,
    @CurrentUser() user: User
  ): Promise<SkuConfig[]> {
    if (!batchUpdateDto.configs || batchUpdateDto.configs.length === 0) {
      throw new BadRequestException('必须提供至少一个配置项');
    }
    return this.basketService.batchUpdateSkuConfigs(user.id, batchUpdateDto.configs);
  }

  @Get('color-groups')
  @ApiOperation({ summary: '获取颜色组列表' })
  async listColorGroups(
    @Query() query: QueryColorGroupsDto,
    @CurrentUser() user: User,
  ) {
    return this.basketService.listColorGroups(user, query);
  }

  @Get('color-groups/options')
  @ApiOperation({ summary: '获取当前用户可用颜色组选项' })
  async colorGroupOptions(@CurrentUser() user: User) {
    return this.basketService.getActiveColorGroups(user);
  }

  @Post('color-groups')
  @ApiOperation({ summary: '创建颜色组' })
  async createColorGroup(@Body() dto: CreateColorGroupDto, @CurrentUser() user: User) {
    return this.basketService.createColorGroup(user, dto);
  }

  @Put('color-groups/:id')
  @ApiOperation({ summary: '更新颜色组' })
  async updateColorGroup(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateColorGroupDto,
    @CurrentUser() user: User,
  ) {
    return this.basketService.updateColorGroup(id, user, dto);
  }

  @Get('color-groups/:id')
  @ApiOperation({ summary: '获取单个颜色组详情' })
  async getColorGroup(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.basketService.getColorGroup(id, user);
  }

  @Delete('color-groups/:id')
  @ApiOperation({ summary: '删除颜色组' })
  async deleteColorGroup(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.basketService.deleteColorGroup(id, user);
  }

  @Get('color-kv')
  @ApiOperation({ summary: '获取颜色字典列表' })
  async listColorKv(@Query() query: QueryColorKvDto, @CurrentUser() user: User) {
    return this.basketService.listColorKv(user, query);
  }

  @Post('color-kv')
  @ApiOperation({ summary: '创建颜色字典项' })
  async createColorKv(@Body() dto: CreateColorKvDto, @CurrentUser() user: User) {
    return this.basketService.createColorKv(user, dto);
  }

  @Post('color-kv/batch')
  @ApiOperation({ summary: '批量新增颜色字典项' })
  async createColorKvBatch(@Body() dto: CreateColorKvBatchDto, @CurrentUser() user: User) {
    return this.basketService.createColorKvBatch(user, dto);
  }

  @Put('color-kv/:id')
  @ApiOperation({ summary: '更新颜色字典项' })
  async updateColorKv(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateColorKvDto,
    @CurrentUser() user: User,
  ) {
    return this.basketService.updateColorKv(id, user, dto);
  }

  @Delete('color-kv/:id')
  @ApiOperation({ summary: '删除颜色字典项' })
  async deleteColorKv(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.basketService.deleteColorKv(id, user);
  }

  @Delete('color-kv')
  @ApiOperation({ summary: '批量删除颜色字典项' })
  async deleteColorKvBatch(@Body() dto: DeleteColorKvBatchDto, @CurrentUser() user: User) {
    return this.basketService.deleteColorKvBatch(dto.ids, user);
  }

  @Get('icon-groups')
  @ApiOperation({ summary: '获取图标组列表' })
  async listIconGroups(@Query() query: QueryIconGroupsDto, @CurrentUser() user: User) {
    return this.basketService.listIconGroups(user, query);
  }

  @Get('icon-groups/options')
  @ApiOperation({ summary: '获取当前用户可用图标组选项' })
  async iconGroupOptions(@CurrentUser() user: User) {
    return this.basketService.getActiveIconGroups(user);
  }

  @Post('icon-groups')
  @ApiOperation({ summary: '创建图标组' })
  async createIconGroup(@Body() dto: CreateIconGroupDto, @CurrentUser() user: User) {
    return this.basketService.createIconGroup(user, dto);
  }

  @Put('icon-groups/:id')
  @ApiOperation({ summary: '更新图标组' })
  async updateIconGroup(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateIconGroupDto,
    @CurrentUser() user: User,
  ) {
    return this.basketService.updateIconGroup(id, user, dto);
  }

  @Delete('icon-groups/:id')
  @ApiOperation({ summary: '删除图标组' })
  async deleteIconGroup(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.basketService.deleteIconGroup(id, user);
  }

  @Get('icon-kv')
  @ApiOperation({ summary: '获取图标字典列表' })
  async listIconKv(@Query() query: QueryIconKvDto, @CurrentUser() user: User) {
    return this.basketService.listIconKv(user, query);
  }

  @Post('icon-kv/upload')
  @ApiOperation({ summary: '上传图标字典项' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: (_req, _file, cb) => cb(null, BASKET_ICONS_DIR),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `basket-icon-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
      },
    }),
  }))
  async createIconKv(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: CreateIconKvDto,
    @CurrentUser() user: User,
  ) {
    return this.basketService.createIconKv(user, dto, file);
  }

  @Put('icon-kv/:id')
  @ApiOperation({ summary: '更新图标字典项' })
  async updateIconKv(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateIconKvDto,
    @CurrentUser() user: User,
  ) {
    return this.basketService.updateIconKv(id, user, dto);
  }

  @Delete('icon-kv/:id')
  @ApiOperation({ summary: '删除图标字典项' })
  async deleteIconKv(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.basketService.deleteIconKv(id, user);
  }

  @Delete('records/:id')
  @ApiOperation({ summary: '删除篮子订单生成记录' })
  @ApiResponse({ status: 200, description: '记录删除成功' })
  @ApiResponse({ status: 404, description: '记录未找到' })
  @ApiForbiddenResponse({ description: '无权删除该记录' })
  async deleteRecord(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User
  ): Promise<void> {
    return this.basketService.deleteGenerationRecord(id, user);
  }

  @Delete('records')
  @ApiOperation({ summary: '批量删除篮子订单生成记录' })
  @ApiResponse({
    status: 200,
    description: '批量删除结果',
    schema: {
      type: 'object',
      properties: {
        deleted: {
          type: 'array',
          items: { type: 'number' },
          description: '成功删除的记录ID列表'
        },
        failed: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              reason: { type: 'string' }
            }
          },
          description: '删除失败的记录及原因'
        }
      }
    }
  })
  @ApiResponse({ status: 400, description: '必须提供至少一个记录ID' })
  @ApiForbiddenResponse({ description: '无权删除某些记录' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          description: '要删除的记录ID数组',
          items: { type: 'number' }
        }
      }
    }
  })
  @ApiQuery({
    name: 'ids',
    required: false,
    description: '要删除的记录ID，可以使用逗号分隔或重复参数',
    type: String,
    isArray: true
  })
  async deleteRecords(
    @Body('ids') bodyIds: number[] | number | string[] | string,
    @Query('ids') queryIds: string | string[],
    @CurrentUser() user: User
  ): Promise<{ deleted: number[]; failed: { id: number; reason: string }[] }> {
    const ids = this.normalizeNumericIds(bodyIds, queryIds);

    if (!ids.length) {
      throw new BadRequestException('必须提供至少一个记录ID');
    }

    return this.basketService.deleteGenerationRecords(ids, user);
  }

  @Post('records/:id/cancel')
  @ApiOperation({ summary: '取消篮子订单生成任务' })
  @ApiResponse({ status: 200, description: '任务取消成功' })
  @ApiResponse({ status: 400, description: '无法取消已完成的任务' })
  @ApiResponse({ status: 404, description: '记录未找到' })
  @ApiForbiddenResponse({ description: '无权取消该任务' })
  async cancelRecordImport(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User
  ): Promise<{ success: boolean; message: string }> {
    return this.basketService.cancelGenerationRecord(id, user);
  }

  @Get('records')
  @ApiOperation({ summary: '获取篮子订单生成记录（分页，可通过文件名/订单ID/SKU搜索）' })
  @ApiResponse({ 
    status: 200, 
    description: '返回分页的生成记录列表',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { $ref: '#/components/schemas/BasketGenerationRecord' }
        },
        meta: {
          type: 'object',
          properties: {
            total: { type: 'number' },
            page: { type: 'number' },
            limit: { type: 'number' },
            totalPages: { type: 'number' }
          }
        }
      }
    }
  })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiQuery({ type: BasketPaginationDto })
  @ApiQuery({ name: 'search', required: false, description: '搜索：文件名/订单ID/SKU（模糊匹配）' })
  @ApiQuery({ 
    name: 'status', 
    required: false, 
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    description: '按处理状态筛选' 
  })
  @ApiQuery({ name: 'startDate', required: false, description: '开始日期 (YYYY-MM-DD)' })
  @ApiQuery({ name: 'endDate', required: false, description: '结束日期 (YYYY-MM-DD)' })
  async getAllRecords(
    @Query() paginationDto: BasketPaginationDto,
    @CurrentUser() user: User
  ): Promise<PaginatedResponse<BasketGenerationRecord>> {
    return this.basketService.getAllGenerationRecords(paginationDto, user);
  }

  @Get('records/all')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '获取所有篮子订单生成记录（分页，仅限管理员）' })
  @ApiResponse({ 
    status: 200, 
    description: '返回分页的所有生成记录列表',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { $ref: '#/components/schemas/BasketGenerationRecord' }
        },
        meta: {
          type: 'object',
          properties: {
            total: { type: 'number' },
            page: { type: 'number' },
            limit: { type: 'number' },
            totalPages: { type: 'number' }
          }
        }
      }
    }
  })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 403, description: '没有管理员权限' })
  @ApiQuery({ type: BasketPaginationDto })
  @ApiQuery({ name: 'search', required: false, description: '按文件名搜索' })
  @ApiQuery({ 
    name: 'status', 
    required: false, 
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    description: '按处理状态筛选' 
  })
  @ApiQuery({ name: 'startDate', required: false, description: '开始日期 (YYYY-MM-DD)' })
  @ApiQuery({ name: 'endDate', required: false, description: '结束日期 (YYYY-MM-DD)' })
  async getAllRecordsAdmin(
    @Query() paginationDto: BasketPaginationDto,
    @CurrentUser() user: User
  ): Promise<PaginatedResponse<BasketGenerationRecord>> {
    return this.basketService.getAllGenerationRecords(paginationDto, user);
  }

  @Get('records/:id')
  @ApiOperation({ summary: '获取特定篮子订单生成记录' })
  @ApiResponse({ status: 200, description: '返回指定的生成记录' })
  @ApiResponse({ status: 404, description: '记录未找到' })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 403, description: '无权访问该记录' })
  async getRecord(
    @Param('id', ParseIntPipe) id: number, 
    @CurrentUser() user: User
  ) {
    return this.basketService.getGenerationRecord(id, user);
  }

  

  @Get('generate/:jobId/status')
  @ApiOperation({ summary: '检查篮子订单PPT生成任务的状态' })
  @ApiParam({ name: 'jobId', description: '生成任务的ID' })
  @ApiResponse({
    status: 200,
    description: '返回当前生成任务的状态',
    schema: {
      type: 'object',
      properties: {
        status: { 
          type: 'string', 
          enum: ['pending', 'processing', 'completed', 'failed'] 
        },
        progress: { 
          type: 'number', 
          description: '完成百分比 (0-100)' 
        },
        message: { 
          type: 'string' 
        },
        result: { 
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            totalOrders: { type: 'number' }
          }
        },
        error: { 
          type: 'string',
          description: '错误信息（如果任务失败）' 
        }
      }
    }
  })
  @ApiResponse({ status: 404, description: '找不到该任务' })
  @ApiResponse({ status: 403, description: '没有访问该任务的权限' })
  async checkGenerationStatus(
    @Param('jobId') jobId: string,
    @CurrentUser() user: User
  ) {
    return this.basketService.checkJobStatus(jobId, user);
  }

  private normalizeNumericIds(
    bodyIds?: number[] | number | string[] | string,
    queryIds?: string | string[]
  ): number[] {
    const idSet = new Set<number>();

    const append = (input?: number | string) => {
      if (input === undefined || input === null) {
        return;
      }

      const value = typeof input === 'number' ? String(input) : input;

      value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .forEach((v) => {
          const parsed = Number(v);
          if (!Number.isNaN(parsed)) {
            idSet.add(parsed);
          }
        });
    };

    if (Array.isArray(bodyIds)) {
      bodyIds.forEach((id) => append(id as any));
    } else if (bodyIds !== undefined) {
      append(bodyIds as any);
    }

    if (Array.isArray(queryIds)) {
      queryIds.forEach((id) => append(id));
    } else {
      append(queryIds);
    }

    return Array.from(idSet);
  }
} 
