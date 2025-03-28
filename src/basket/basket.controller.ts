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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody, ApiBearerAuth, ApiQuery, ApiParam } from '@nestjs/swagger';
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

@ApiTags('baskets')
@Controller('baskets')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class BasketController {
  constructor(private readonly basketService: BasketService) {}

  @Post('generate')
  @ApiOperation({ summary: '生成篮子订单PPT' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: '订单PPT生成任务已创建', type: BasketGenerationResponseDto })
  @ApiResponse({ status: 400, description: '无效的文件类型或参数' })
  @ApiResponse({ status: 401, description: '未授权' })
  @UseInterceptors(FileInterceptor('file'))
  async generateBasketOrders(
    @UploadedFile() file: Express.Multer.File,
    @Body('originalFilename') originalFilename: string,
    @CurrentUser() user: User,
  ): Promise<BasketGenerationResponseDto> {
    if (!file) {
      throw new BadRequestException('没有提供Excel文件');
    }
    
    return this.basketService.generateBasketOrders(file, user, originalFilename);
  }

  @Get('records')
  @ApiOperation({ summary: '获取篮子订单生成记录（分页）' })
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
  @ApiQuery({ name: 'search', required: false, description: '按文件名搜索' })
  @ApiQuery({ 
    name: 'status', 
    required: false, 
    enum: ['pending', 'processing', 'completed', 'failed'],
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
    enum: ['pending', 'processing', 'completed', 'failed'],
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
} 