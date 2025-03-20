import { Controller, Get, Post, Body, Patch, Param, Delete, UseInterceptors, UploadedFile, BadRequestException, Query, Put, ParseIntPipe } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStampDto } from './dto/update-order-stamp.dto';
import { ExcelService } from './services/excel.service';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody, ApiQuery } from '@nestjs/swagger';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Order } from './entities/order.entity';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly excelService: ExcelService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new order' })
  @ApiResponse({ status: 201, description: 'The order has been successfully created.' })
  @ApiResponse({ status: 400, description: 'Invalid input data.' })
  create(@Body() createOrderDto: CreateOrderDto) {
    return this.ordersService.create(createOrderDto);
  }

  @Post('upload')
  @ApiOperation({ summary: 'Upload Etsy orders from Excel file and generate stamps' })
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
            failedOrders: { type: 'number' },
            generatedStamps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  orderId: { type: 'string' },
                  stampPath: { type: 'string' }
                }
              }
            },
            skippedStamps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  orderId: { type: 'string' },
                  reason: { type: 'string' }
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
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
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
          failedOrders: result.failed,
          generatedStamps: result.stamps,
          skippedStamps: result.skippedStamps
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

  @Get(':id')
  @ApiOperation({ summary: 'Get a single order by ID' })
  @ApiResponse({
    status: 200,
    description: 'Returns the order if found',
    type: Order
  })
  @ApiResponse({ status: 404, description: 'Order not found' })
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an order' })
  @ApiResponse({ status: 200, description: 'The order has been successfully updated.' })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  update(@Param('id') id: string, @Body() updateOrderDto: Partial<CreateOrderDto>) {
    return this.ordersService.update(id, updateOrderDto);
  }

  @Post('update-stamp')
  @ApiOperation({ summary: '手动调整订单图章的内容及排布，生成新的印章' })
  @ApiResponse({
    status: 200,
    description: '图章更新成功',
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
  @ApiBody({ type: UpdateOrderStampDto })
  async updateOrderStamp(@Body() updateOrderStampDto: UpdateOrderStampDto) {
    const result = await this.ordersService.updateOrderStamp(updateOrderStampDto);
    
    if (!result.success) {
      throw new BadRequestException(result.error);
    }
    
    return {
      success: true,
      path: result.path,
      recordId: result.recordId
    };
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
  @ApiOperation({ summary: '获取订单的最新一条印章生成记录，包含完整的样式和位置信息' })
  @ApiResponse({
    status: 200,
    description: '返回订单的最新印章生成记录，包含所有文本元素的位置、样式等完整信息',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        orderId: { type: 'string' },
        templateId: { type: 'number' },
        textElements: { 
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '文本元素ID' },
              value: { type: 'string', description: '文本内容' },
              fontFamily: { type: 'string', description: '字体' },
              fontSize: { type: 'number', description: '字体大小' },
              fontWeight: { type: 'string', description: '字体粗细' },
              fontStyle: { type: 'string', description: '字体样式' },
              color: { type: 'string', description: '颜色' },
              position: {
                type: 'object',
                properties: {
                  x: { type: 'number', description: 'X坐标' },
                  y: { type: 'number', description: 'Y坐标' },
                  width: { type: 'number', description: '宽度' },
                  height: { type: 'number', description: '高度' },
                  rotation: { type: 'number', description: '旋转角度' },
                  textAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '文本对齐方式' }
                }
              }
            }
          }
        },
        stampImageUrl: { type: 'string' },
        format: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
        template: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            sku: { type: 'string' },
            textElements: {
              type: 'array',
              items: {
                type: 'object'
              }
            }
          }
        }
      }
    }
  })
  @ApiResponse({ status: 404, description: '订单不存在或没有生成记录' })
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
} 