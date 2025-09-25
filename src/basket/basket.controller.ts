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

import { BasketService } from './basket.service';
import { BasketGenerationResponseDto } from './dto/basket-generation-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { BasketPaginationDto } from './dto/basket-pagination.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { BasketGenerationRecord } from './entities/basket-generation-record.entity';
import { CreateSkuConfigDto, SkuConfigResponseDto } from './dto/sku-config.dto';
import { SkuConfig } from './entities/sku-config.entity';

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
  @UseInterceptors(FileInterceptor('file'))
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