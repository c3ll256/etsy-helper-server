import { Controller, Get, Post, Body, Patch, Param, Delete, UseInterceptors, UploadedFile, BadRequestException, Query, Put, Res, NotFoundException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateStampDto } from './dto/update-stamp.dto';
import { ExportStampsDto } from './dto/export-stamps.dto';
import { ExcelService } from './services/excel.service';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody, ApiQuery, ApiParam } from '@nestjs/swagger';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Order } from './entities/order.entity';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { In } from 'typeorm';
import { StampGenerationRecord } from '../stamps/entities/stamp-generation-record.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobQueueService } from './services/job-queue.service';

@ApiTags('orders')
@Controller('orders')
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
  create(@Body() createOrderDto: CreateOrderDto) {
    return this.ordersService.create(createOrderDto);
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
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    if (!file.originalname.match(/\.(xlsx|xls)$/)) {
      throw new BadRequestException('Please upload an Excel file');
    }

    try {
      // Start asynchronous processing
      const jobId = await this.excelService.processExcelFileAsync(file);
      
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
  checkJobStatus(@Param('jobId') jobId: string) {
    const jobProgress = this.jobQueueService.getJobProgress(jobId);
    
    if (!jobProgress) {
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
    }
    
    // Add error if available
    if (jobProgress.error) {
      response.error = jobProgress.error;
    }
    
    return response;
  }

  // Kept for backward compatibility - now calls the async version
  @Post('upload-sync')
  @ApiOperation({ summary: 'Upload Etsy orders from Excel file and generate stamps (synchronous version)' })
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
    status: 200,
    description: 'File processed successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        details: {
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
            }
          }
        }
      }
    }
  })
  @ApiResponse({ status: 400, description: 'Invalid file or file processing error.' })
  @UseInterceptors(FileInterceptor('file'))
  async uploadFileSync(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    if (!file.originalname.match(/\.(xlsx|xls)$/)) {
      throw new BadRequestException('Please upload an Excel file');
    }

    try {
      const result = await this.excelService.parseExcelFile(file);
      return {
        message: 'File processed successfully',
        details: {
          totalOrders: result.total,
          newOrdersCreated: result.created,
          duplicateOrdersSkipped: result.skipped,
          skippedReasons: result.skippedReasons,
          failedOrders: result.failed,
          generatedStamps: result.stamps
        }
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
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
    enum: ['stamp_not_generated', 'stamp_generated_pending_review', 'stamp_generated_reviewed'],
    description: '按订单状态筛选' 
  })
  findAll(@Query() paginationDto: PaginationDto): Promise<PaginatedResponse<Order>> {
    return this.ordersService.findAll(paginationDto);
  }

  @Get('export-stamps')
  @ApiOperation({ summary: '将指定时间段内的订单印章导出为zip包' })
  @ApiResponse({
    status: 200,
    description: '导出成功，返回zip文件',
    schema: {
      type: 'string',
      format: 'binary'
    }
  })
  @ApiResponse({ status: 400, description: '请求处理失败' })
  @ApiResponse({ status: 404, description: '没有找到符合条件的订单印章' })
  @ApiQuery({ 
    name: 'search', 
    required: false, 
    description: '搜索订单号' 
  })
  @ApiQuery({ 
    name: 'status', 
    required: false, 
    enum: ['stamp_not_generated', 'stamp_generated_pending_review', 'stamp_generated_reviewed'],
    description: '按订单状态筛选' 
  })
  async exportStamps(
    @Query() exportStampsDto: ExportStampsDto,
    @Res() res: Response
  ) {
    try {
      const result = await this.ordersService.exportStampsAsZip(
        exportStampsDto.startDate,
        exportStampsDto.endDate,
        exportStampsDto.search,
        exportStampsDto.status
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
      
      console.log(`Sending zip file: ${result.filePath}, size: ${stats.size} bytes, contains ${result.orderCount} stamps`);

      // 设置响应头
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.setHeader('Content-Length', stats.size);
      
      // 创建文件流并发送文件
      const fileStream = fs.createReadStream(result.filePath);
      fileStream.pipe(res);
      
      // 不再删除文件，而是保留
      console.log(`ZIP文件已保存在: ${result.filePath}`);
      
      // 处理错误
      fileStream.on('error', (err) => {
        console.error(`Error sending file: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).send(`Error sending file: ${err.message}`);
        }
      });
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
  async findOne(@Param('id') id: string): Promise<any> {
    const order = await this.ordersService.findOne(id);
    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found`);
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
  update(@Param('id') id: string, @Body() updateOrderDto: Partial<CreateOrderDto>) {
    return this.ordersService.update(id, updateOrderDto);
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
  async getOrderStampRecords(@Param('id') id: string) {
    return this.ordersService.getOrderStampRecords(id);
  }

  @Get(':id/latest-stamp-record')
  @ApiOperation({ summary: '获取订单最新的印章生成记录' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '订单未找到或无印章记录' })
  async getOrderLatestStampRecord(@Param('id') id: string) {
    return this.ordersService.getOrderLatestStampRecord(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an order' })
  @ApiResponse({ status: 200, description: 'The order has been successfully deleted.' })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  remove(@Param('id') id: string) {
    return this.ordersService.remove(id);
  }

  @Get('exports')
  @ApiOperation({ summary: '列出所有已导出的图章包' })
  @ApiResponse({
    status: 200,
    description: '返回所有导出的文件列表',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fileName: { type: 'string' },
          fileSize: { type: 'number' },
          createdAt: { type: 'string', format: 'date-time' },
          downloadUrl: { type: 'string' }
        }
      }
    }
  })
  listExports() {
    try {
      const exportDir = path.join(process.cwd(), 'uploads', 'exports');
      
      // 确保目录存在
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
        return [];
      }
      
      // 读取目录下所有文件
      const files = fs.readdirSync(exportDir)
        .filter(file => file.endsWith('.zip'))
        .map(file => {
          const filePath = path.join(exportDir, file);
          const stats = fs.statSync(filePath);
          
          return {
            fileName: file,
            fileSize: stats.size,
            createdAt: stats.mtime,
            downloadUrl: `/uploads/exports/${file}`
          };
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); // 按修改时间降序排序
      
      return files;
    } catch (error) {
      console.error('Error listing exports:', error);
      return [];
    }
  }
  
  @Get('exports/:fileName')
  @ApiOperation({ summary: '下载指定的导出文件' })
  @ApiResponse({
    status: 200,
    description: '返回导出的文件',
    schema: {
      type: 'string',
      format: 'binary'
    }
  })
  @ApiResponse({ status: 404, description: '文件不存在' })
  downloadExport(@Param('fileName') fileName: string, @Res() res: Response) {
    try {
      // 确保文件名不包含路径攻击
      const sanitizedFileName = path.basename(fileName);
      const filePath = path.join(process.cwd(), 'uploads', 'exports', sanitizedFileName);
      
      if (!fs.existsSync(filePath)) {
        throw new NotFoundException(`File ${sanitizedFileName} not found`);
      }
      
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        throw new BadRequestException(`File ${sanitizedFileName} is empty`);
      }
      
      // 设置响应头
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFileName}"`);
      res.setHeader('Content-Length', stats.size);
      
      // 创建文件流并发送文件
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      
      // 处理错误
      fileStream.on('error', (err) => {
        console.error(`Error sending file: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).send(`Error sending file: ${err.message}`);
        }
      });
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(error.message);
    }
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
    @Body() updateStampDto: UpdateStampDto
  ): Promise<any> {
    try {
      const result = await this.ordersService.updateOrderStamp(id, updateStampDto);
      
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
} 