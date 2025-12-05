import { Controller, Get, Post, Body, Patch, Param, Delete, UseInterceptors, UploadedFile, BadRequestException, Query, Put, Res, NotFoundException, UseGuards } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateStampDto } from './dto/update-stamp.dto';
import { ExportStampsDto } from './dto/export-stamps.dto';
import { ExcelService } from './services/excel.service';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody, ApiQuery, ApiParam, ApiBearerAuth, ApiForbiddenResponse } from '@nestjs/swagger';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Order } from './entities/order.entity';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import * as fs from 'fs';
import * as path from 'path';
import { In } from 'typeorm';
import { StampGenerationRecord } from '../stamps/entities/stamp-generation-record.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobQueueService } from '../common/services/job-queue.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { OrderStatus } from 'src/orders/enums/order.enum';
import { StampType } from 'src/stamps/entities/stamp-template.entity';

@ApiTags('orders')
@Controller('orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly excelService: ExcelService,
    private readonly jobQueueService: JobQueueService,
    @InjectRepository(StampGenerationRecord)
    private readonly stampGenerationRecordRepository: Repository<StampGenerationRecord>,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new order' })
  @ApiResponse({ status: 201, description: 'The order has been successfully created.' })
  @ApiResponse({ status: 400, description: 'Invalid input data.' })
  create(@Body() createOrderDto: CreateOrderDto, @CurrentUser() user: User) {
    return this.ordersService.create(createOrderDto, user);
  }

  @Post('upload')
  @ApiOperation({ summary: 'Upload Etsy orders from Excel file and generate stamps asynchronously' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Excel file containing Etsy orders'
        }
      }
    }
  })
  @ApiResponse({
    status: 202,
    description: 'File accepted for processing',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        jobId: { type: 'string' },
        status: { type: 'string' }
      }
    }
  })
  @ApiResponse({ status: 400, description: 'Invalid file or file processing error.' })
  @UseInterceptors(FileInterceptor('file', {
    limits: {
      fileSize: 50 * 1024 * 1024, // SECURITY: 限制Excel文件大小为50MB，防止DoS攻击
    }
  }))
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    // SECURITY: 验证文件扩展名，防止路径遍历
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ext.match(/^\.(xlsx|xls)$/)) {
      throw new BadRequestException('Please upload an Excel file (.xlsx or .xls)');
    }
    
    // SECURITY: 验证文件名不包含路径遍历字符
    if (file.originalname.includes('..') || file.originalname.includes('/') || file.originalname.includes('\\')) {
      throw new BadRequestException('Invalid filename');
    }

    try {
      // Start asynchronous processing with the current user
      const jobId = await this.excelService.processExcelFileAsync(file, user);
      
      return {
        message: 'File accepted for processing',
        jobId,
        status: 'processing'
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  @Get('upload/:jobId/status')
  @ApiOperation({ summary: 'Check the status of an Excel file processing job' })
  @ApiParam({ name: 'jobId', description: 'The ID of the processing job' })
  @ApiResponse({
    status: 200,
    description: 'Returns the current status of the processing job',
    schema: {
      type: 'object',
      properties: {
        status: { 
          type: 'string', 
          enum: ['pending', 'processing', 'completed', 'failed'] 
        },
        progress: { 
          type: 'number', 
          description: 'Percentage of completion (0-100)' 
        },
        message: { 
          type: 'string' 
        },
        result: { 
          type: 'object',
          properties: {
            totalOrders: { type: 'number' },
            newOrdersCreated: { type: 'number' },
            duplicateOrdersSkipped: { type: 'number' },
            skippedReasons: { 
              type: 'array', 
              items: { 
                type: 'object',
                properties: {
                  orderId: { type: 'string' },
                  transactionId: { type: 'string' },
                  reason: { type: 'string' }
                }
              } 
            },
            failedOrders: { type: 'number' },
            generatedStamps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  orderId: { type: 'string' },
                  transactionId: { type: 'string' },
                  stampPath: { type: 'string' }
                }
              }
            },
            reportPath: {
              type: 'string',
              description: '处理报告 Excel 文件路径（处理完成后可用）',
              example: '/uploads/exports/processing_report_2024-01-01T12-00-00-000Z.xlsx'
            }
          }
        },
        error: { 
          type: 'string',
          description: 'Error message if the job failed' 
        }
      }
    }
  })
  @ApiResponse({ status: 404, description: 'Job not found' })
  checkJobStatus(@Param('jobId') jobId: string, @CurrentUser() user: User) {
    const jobProgress = this.jobQueueService.getJobProgress(jobId);
    
    if (!jobProgress) {
      throw new NotFoundException(`Job with ID ${jobId} not found`);
    }
    
    // Check if job belongs to user (unless admin)
    if (!user.isAdmin && jobProgress.userId && jobProgress.userId !== user.id) {
      throw new NotFoundException(`Job with ID ${jobId} not found`);
    }
    
    // Format the response for the client
    let response: any = {
      status: jobProgress.status,
      progress: jobProgress.progress,
      message: jobProgress.message
    };
    
    // Add result if available
    if (jobProgress.result) {
      response.result = {
        totalOrders: jobProgress.result.total,
        newOrdersCreated: jobProgress.result.created,
        duplicateOrdersSkipped: jobProgress.result.skipped,
        skippedReasons: jobProgress.result.skippedReasons,
        failedOrders: jobProgress.result.failed,
        generatedStamps: jobProgress.result.stamps
      };
      
      // Add report path if available (convert to web-accessible path)
      if (jobProgress.result.reportPath) {
        let reportPath = jobProgress.result.reportPath;
        // Convert to web-accessible path if needed
        // Handle different path formats: absolute, relative, or already web-accessible
        if (path.isAbsolute(reportPath)) {
          // Absolute path: extract filename and make it web-accessible
          const fileName = path.basename(reportPath);
          reportPath = `/uploads/exports/${fileName}`;
        } else if (!reportPath.startsWith('/uploads')) {
          // Relative path: extract filename and make it web-accessible
          const fileName = path.basename(reportPath);
          reportPath = `/uploads/exports/${fileName}`;
        } else if (!reportPath.startsWith('/')) {
          // Path starts with uploads but missing leading slash
          reportPath = `/${reportPath}`;
        }
        // Path is already in correct format (/uploads/exports/...)
        response.result.reportPath = reportPath;
      }
    }
    
    // Add error if available
    if (jobProgress.error) {
      response.error = jobProgress.error;
    }
    
    return response;
  }

  @Get()
  @ApiOperation({ summary: 'Get all orders' })
  @ApiResponse({
    status: 200,
    description: 'Returns a paginated list of orders',
    type: Order,
    isArray: true
  })
  @ApiQuery({ type: PaginationDto })
  @ApiQuery({ 
    name: 'search', 
    required: false, 
    description: '搜索订单号' 
  })
  @ApiQuery({ 
    name: 'status', 
    required: false, 
    enum: OrderStatus,
    description: '按订单状态筛选' 
  })
  @ApiQuery({ 
    name: 'userId', 
    required: false, 
    description: '按用户ID筛选（仅限管理员）' 
  })
  @ApiQuery({ 
    name: 'templateIds', 
    required: false, 
    description: '按印章模板ID筛选（多选）', 
    type: [Number],
    isArray: true
  })
  @ApiQuery({ 
    name: 'stampType', 
    required: false, 
    enum: StampType,
    description: '按印章类型筛选' 
  })
  findAll(@Query() paginationDto: PaginationDto, @CurrentUser() user: User): Promise<PaginatedResponse<Order>> {
    return this.ordersService.findAll(paginationDto, user);
  }

  @ApiOperation({ summary: '导出订单为Excel，包含印章图片，可按条件筛选或直接指定订单ID导出' })
  @ApiResponse({
    status: 200,
    description: '导出成功，返回Excel文件路径',
    schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        fileName: { type: 'string' }
      }
    }
  })
  @ApiResponse({ status: 400, description: '请求处理失败' })
  @ApiResponse({ status: 404, description: '没有找到符合条件的订单' })
  @ApiBody({ type: ExportStampsDto })
  @Post('export-excel')
  async exportOrdersToExcel(
    @Body() exportDto: ExportStampsDto,
    @CurrentUser() user: User
  ) {
    try {
      const result = await this.ordersService.exportOrdersToExcel(
        exportDto.startDate,
        exportDto.endDate,
        exportDto.search,
        exportDto.status,
        user,
        exportDto.templateIds,
        exportDto.stampType,
        exportDto.orderIds
      );

      return {
        filePath: `/${result.filePath}`,
        fileName: result.fileName
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(error.message);
    }
  }

  @Post('export-stamps')
  @ApiOperation({ summary: '将指定时间段内的订单印章导出为zip包，或指定订单ID直接导出' })
  @ApiResponse({
    status: 200,
    description: '导出成功，返回zip文件路径',
    schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        fileName: { type: 'string' },
        orderCount: { type: 'number' }
      }
    }
  })
  @ApiResponse({ status: 400, description: '请求处理失败' })
  @ApiResponse({ status: 404, description: '没有找到符合条件的订单印章' })
  @ApiBody({ type: ExportStampsDto })
  async exportStamps(
    @Body() exportStampsDto: ExportStampsDto,
    @CurrentUser() user: User
  ) {
    try {
      const result = await this.ordersService.exportStampsAsZip(
        exportStampsDto.startDate,
        exportStampsDto.endDate,
        exportStampsDto.search,
        exportStampsDto.status,
        user,
        exportStampsDto.templateIds,
        exportStampsDto.stampType,
        exportStampsDto.orderIds,
        exportStampsDto.sku
      );

      // 确保文件存在且有效
      if (!fs.existsSync(result.filePath)) {
        throw new BadRequestException(`Generated file does not exist: ${result.filePath}`);
      }

      // 检查文件大小
      const stats = fs.statSync(result.filePath);
      if (stats.size === 0) {
        throw new BadRequestException('Generated zip file is empty');
      }
      
      console.log(`Zip file generated: ${result.filePath}, size: ${stats.size} bytes, contains ${result.orderCount} stamps`);

      return {
        filePath: `/${result.filePath}`,
        fileName: result.fileName,
        orderCount: result.orderCount
      };
    } catch (error) {
      console.error('Error in exportStamps:', error);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(error.message);
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single order by ID' })
  @ApiResponse({
    status: 200,
    description: 'Returns the order if found',
    type: Order
  })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async findOne(@Param('id') id: string, @CurrentUser() user: User): Promise<any> {
    const order = await this.ordersService.findOne(id, user);
    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found or you don't have permission to access it`);
    }

    // 获取关联的印章生成记录
    let stampGenerationRecords = [];
    if (order.etsyOrder && order.etsyOrder.stampGenerationRecordIds && order.etsyOrder.stampGenerationRecordIds.length > 0) {
      const recordIds = order.etsyOrder.stampGenerationRecordIds;
      stampGenerationRecords = await this.stampGenerationRecordRepository.find({
        where: { 
          id: In(recordIds) 
        }
      });
    }

    // 返回包含印章生成记录的订单详情
    return {
      ...order,
      stampGenerationRecords
    };
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an order' })
  @ApiResponse({ status: 200, description: 'The order has been successfully updated.' })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  update(
    @Param('id') id: string, 
    @Body() updateOrderDto: Partial<CreateOrderDto>,
    @CurrentUser() user: User
  ) {
    return this.ordersService.update(id, updateOrderDto, user);
  }

  @Get(':id/stamp-records')
  @ApiOperation({ summary: '获取订单的印章生成记录' })
  @ApiResponse({
    status: 200,
    description: '返回订单的印章生成记录列表',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          orderId: { type: 'string' },
          templateId: { type: 'number' },
          textElements: { type: 'array' },
          stampImageUrl: { type: 'string' },
          format: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          template: { 
            type: 'object',
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
              sku: { type: 'string' }
            }
          }
        }
      }
    }
  })
  @ApiResponse({ status: 404, description: '订单不存在' })
  async getOrderStampRecords(@Param('id') id: string, @CurrentUser() user: User) {
    return this.ordersService.getOrderStampRecords(id, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an order' })
  @ApiResponse({ status: 200, description: 'The order has been successfully deleted.' })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.ordersService.remove(id, user);
  }

  @Delete()
  @ApiOperation({ summary: 'Delete multiple orders' })
  @ApiResponse({
    status: 200,
    description: 'Orders deleted successfully.',
    schema: {
      type: 'object',
      properties: {
        deleted: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of successfully deleted order IDs'
        },
        failed: {
          type: 'array',
          description: 'List of order IDs that failed to delete with reasons',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              reason: { type: 'string' }
            }
          }
        }
      }
    }
  })
  @ApiResponse({ status: 400, description: 'No valid order IDs provided.' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          description: 'Order ID array to delete',
          items: { type: 'string' }
        }
      }
    }
  })
  @ApiQuery({
    name: 'ids',
    required: false,
    description: 'Comma-separated order IDs or multiple query parameters',
    type: String,
    isArray: true
  })
  async removeMany(
    @Body('ids') bodyIds: string[] | string,
    @Query('ids') queryIds: string | string[],
    @CurrentUser() user: User
  ) {
    const ids = this.normalizeIds(bodyIds, queryIds);

    if (!ids.length) {
      throw new BadRequestException('At least one order ID must be provided');
    }

    return this.ordersService.removeMany(ids, user);
  }

  private normalizeIds(
    bodyIds?: string[] | string,
    queryIds?: string | string[]
  ): string[] {
    const idSet = new Set<string>();

    const append = (value?: string) => {
      if (!value) {
        return;
      }
      value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .forEach((v) => idSet.add(v));
    };

    if (Array.isArray(bodyIds)) {
      bodyIds.forEach((id) => append(id));
    } else if (typeof bodyIds === 'string') {
      append(bodyIds);
    }

    if (Array.isArray(queryIds)) {
      queryIds.forEach((id) => append(id));
    } else if (typeof queryIds === 'string') {
      append(queryIds);
    }

    return Array.from(idSet);
  }

  @Delete('stamp-records/:recordId')
  @ApiOperation({ summary: '删除印章生成记录' })
  @ApiResponse({ status: 200, description: '印章生成记录删除成功' })
  @ApiResponse({ status: 404, description: '印章生成记录不存在' })
  @ApiForbiddenResponse({ description: '无权删除该印章生成记录' })
  async deleteStampRecord(
    @Param('recordId') recordId: string,
    @CurrentUser() user: User
  ) {
    return this.ordersService.deleteStampGenerationRecord(+recordId, user);
  }

  @Post('stamp-records/:jobId/cancel')
  @ApiOperation({ summary: '根据任务ID取消印章生成任务' })
  @ApiParam({ name: 'jobId', description: '上传任务返回的 jobId' })
  @ApiResponse({ status: 200, description: '任务取消成功' })
  @ApiResponse({ status: 400, description: '任务无法取消或参数无效' })
  @ApiResponse({ status: 404, description: '对应的任务或记录不存在' })
  @ApiForbiddenResponse({ description: '无权取消该任务' })
  async cancelStampRecord(
    @Param('jobId') jobId: string,
    @CurrentUser() user: User
  ) {
    if (!jobId) {
      throw new BadRequestException('Job ID is required');
    }

    return this.ordersService.cancelStampGenerationByJobId(jobId, user);
  }

  @ApiOperation({ summary: '更新指定订单的印章' })
  @ApiResponse({
    status: 200,
    description: '印章更新成功',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        path: { type: 'string' },
        recordId: { type: 'number' }
      }
    }
  })
  @ApiResponse({ status: 400, description: '请求处理失败' })
  @ApiResponse({ status: 404, description: '订单不存在' })
  @ApiBody({ type: UpdateStampDto })
  @Patch(':id/stamp')
  async updateOrderStampById(
    @Param('id') id: string,
    @Body() updateStampDto: UpdateStampDto,
    @CurrentUser() user: User
  ): Promise<any> {
    try {
      const result = await this.ordersService.updateOrderStamp(id, updateStampDto, user);
      
      return {
        success: true,
        message: 'Order stamp updated successfully',
        path: result.path,
        recordId: result.recordId
      };
    } catch (error) {
      throw new BadRequestException(`Failed to update order stamp: ${error.message}`);
    }
  }

  @Get('stamp-records/:recordId')
  @ApiOperation({ summary: '通过印章生成ID获取印章生成记录' })
  @ApiParam({ name: 'recordId', description: '印章生成记录ID' })
  @ApiResponse({
    status: 200,
    description: '返回印章生成记录',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        orderId: { type: 'string' },
        templateId: { type: 'number' },
        textElements: { type: 'array' },
        stampImageUrl: { type: 'string' },
        format: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
        template: { 
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            sku: { type: 'string' }
          }
        }
      }
    }
  })
  @ApiResponse({ status: 404, description: '印章生成记录不存在' })
  async getStampRecordById(@Param('recordId') recordId: string, @CurrentUser() user: User) {
    // First verify if the user has access to the record
    const record = await this.stampGenerationRecordRepository.findOne({
      where: { id: +recordId },
      relations: ['template']
    });
    
    if (!record) {
      throw new NotFoundException(`Stamp generation record with ID ${recordId} not found`);
    }
    
    // If the user is not an admin, check if they have access to the order
    if (!user.isAdmin) {
      try {
        // This will throw an exception if the user doesn't have access to this order
        await this.ordersService.findOne(record.orderId, user);
      } catch (error) {
        throw new NotFoundException(`Stamp generation record with ID ${recordId} not found`);
      }
    }
    
    return record;
  }
} 