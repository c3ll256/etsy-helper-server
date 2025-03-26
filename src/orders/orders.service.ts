import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as AdmZip from 'adm-zip';
import { Order } from './entities/order.entity';
import { EtsyOrder } from './entities/etsy-order.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { StampsService } from '../stamps/stamps.service';
import { OrderStampService } from '../stamps/services/order-stamp.service';
import { ExcelService } from './services/excel.service';
import { UpdateStampDto } from './dto/update-stamp.dto';

@Injectable()
export class OrdersService {
  private readonly stampsOutputDir = 'uploads/stamps';
  private readonly exportsOutputDir = 'uploads/exports';

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @InjectRepository(EtsyOrder)
    private etsyOrderRepository: Repository<EtsyOrder>,
    private readonly stampsService: StampsService,
    private readonly orderStampService: OrderStampService,
    private readonly excelService: ExcelService,
  ) {
    // 确保输出目录存在
    if (!fs.existsSync(this.stampsOutputDir)) {
      fs.mkdirSync(this.stampsOutputDir, { recursive: true });
    }
    
    // 确保导出目录存在
    if (!fs.existsSync(this.exportsOutputDir)) {
      fs.mkdirSync(this.exportsOutputDir, { recursive: true });
    }
  }

  async create(createOrderDto: CreateOrderDto): Promise<Order> {
    const order = this.ordersRepository.create({
      status: createOrderDto.status,
      orderType: createOrderDto.orderType
    });
    return await this.ordersRepository.save(order);
  }

  private async addOrderDetails(orders: Order[]): Promise<Order[]> {
    return orders.map(order => {
      const orderWithDetails = { ...order };
      if (order.orderType === 'etsy' && order.etsyOrder) {
        orderWithDetails.orderDetails = order.etsyOrder;
      } else {
        orderWithDetails.orderDetails = null;
      }
      return orderWithDetails;
    });
  }

  // Helper method to apply date filters to any query builder
  private applyDateFilters(queryBuilder: any, startDate?: string, endDate?: string): void {
    // Handle case when only startDate is provided
    if (startDate && !endDate) {
      queryBuilder.andWhere('date_trunc(\'day\', "order"."createdAt") >= date_trunc(\'day\', :startDate::timestamp)', { 
        startDate: startDate 
      });
      return;
    }
    
    // Handle case when only endDate is provided
    if (!startDate && endDate) {
      queryBuilder.andWhere('date_trunc(\'day\', "order"."createdAt") <= date_trunc(\'day\', :endDate::timestamp)', { 
        endDate: endDate 
      });
      return;
    }
    
    // Handle case when startDate and endDate are the same
    if (startDate && endDate && startDate === endDate) {;
      queryBuilder.andWhere('date_trunc(\'day\', "order"."createdAt") = date_trunc(\'day\', :sameDate::timestamp)', {
        sameDate: startDate
      });
      return;
    }
    
    // Handle normal date range (both startDate and endDate provided)
    if (startDate && endDate) {
      queryBuilder.andWhere('date_trunc(\'day\', "order"."createdAt") >= date_trunc(\'day\', :startDate::timestamp)', { 
        startDate: startDate
      });
      queryBuilder.andWhere('date_trunc(\'day\', "order"."createdAt") <= date_trunc(\'day\', :endDate::timestamp)', { 
        endDate: endDate
      });
    }
  }

  async findAll(paginationDto: PaginationDto): Promise<PaginatedResponse<Order>> {
    const { page = 1, limit = 10, search, status, startDate, endDate } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.ordersRepository.createQueryBuilder('order')
      .leftJoinAndSelect('order.etsyOrder', 'etsyOrder')
      .orderBy('order.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    // Apply status filter if provided
    if (status) {
      queryBuilder.andWhere('order.status = :status', { status });
    }

    // Apply date filters
    this.applyDateFilters(queryBuilder, startDate, endDate);

    // Apply search filter if provided
    if (search) {
      queryBuilder.andWhere(
        '(etsyOrder.orderId LIKE :search OR CAST(order.id as TEXT) LIKE :search OR order.platformOrderId LIKE :search OR order.searchKey ILIKE :search)',
        { search: `%${search}%` }
      );
    }

    const [items, total] = await queryBuilder.getManyAndCount();
    const ordersWithDetails = await this.addOrderDetails(items);

    return {
      items: ordersWithDetails,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['etsyOrder']
    });

    if (!order) {
      throw new NotFoundException(`Order with ID "${id}" not found`);
    }

    const [orderWithDetails] = await this.addOrderDetails([order]);
    return orderWithDetails;
  }

  async update(id: string, updateOrderDto: Partial<CreateOrderDto>): Promise<Order> {
    const order = await this.findOne(id);
    Object.assign(order, updateOrderDto);
    return await this.ordersRepository.save(order);
  }

  async remove(id: string): Promise<void> {
    const result = await this.ordersRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`Order with ID "${id}" not found`);
    }
  }

  /**
   * 使用指定的ID更新订单印章
   * @param id 订单ID
   * @param updateStampDto 更新印章的数据
   * @returns 包含成功状态、路径和记录ID的结果
   */
  async updateOrderStamp(id: string, updateStampDto: UpdateStampDto): Promise<{ success: boolean; path?: string; error?: string; recordId?: number }> {
    try {
      // 查找订单
      const order = await this.ordersRepository.findOne({
        where: { id },
        relations: ['etsyOrder'],
      });

      if (!order) {
        throw new NotFoundException(`Order with ID ${id} not found`);
      }

      // 创建适合印章生成的临时订单对象
      // 当使用textElements时，确保准备一个空的personalization对象，防止警告
      const orderForStampGeneration = {
        ...order.etsyOrder,
        order_id: order.id,
        // 确保variations存在，即使是空对象
        variations: order.etsyOrder.variations || {}
      };

      // 如果提供了自定义文本元素，为了防止警告，我们添加一个空的personalization对象
      if (updateStampDto.textElements && updateStampDto.textElements.length > 0) {
        // 确保variations有一个空的personalization对象，这样不会触发警告
        orderForStampGeneration.variations.personalization = {};
      }

      // 使用orderStampService生成印章并创建记录
      const result = await this.orderStampService.generateStampFromOrder({
        order: orderForStampGeneration,
        customTextElements: updateStampDto.textElements,
        customTemplateId: updateStampDto.templateId,
        convertTextToPaths: updateStampDto.convertTextToPaths || true
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error
        };
      }
      
      // 获取当前的印章记录ID列表
      const currentRecordIds = order.etsyOrder.stampGenerationRecordIds || [];
      const currentStampUrls = order.etsyOrder.stampImageUrls || [];
      
      // 如果提供了oldRecordId，替换对应的记录ID和URL
      if (updateStampDto.oldRecordId && result.recordId) {
        const oldRecordId = updateStampDto.oldRecordId;
        
        // 找到旧记录ID的索引
        const oldIndex = currentRecordIds.indexOf(oldRecordId);
        
        if (oldIndex !== -1) {
          // 如果找到了旧记录ID，替换它和对应的URL
          const updatedRecordIds = [...currentRecordIds];
          updatedRecordIds[oldIndex] = result.recordId;
          
          // 同时更新URL列表
          const updatedStampUrls = [...currentStampUrls];
          if (oldIndex < updatedStampUrls.length) {
            updatedStampUrls[oldIndex] = result.path;
          } else {
            updatedStampUrls.push(result.path);
          }
          
          // 更新EtsyOrder的印章URL和记录ID（替换模式）
          await this.etsyOrderRepository.update(
            { orderId: order.etsyOrder.orderId },
            { 
              stampImageUrls: updatedStampUrls,
              stampGenerationRecordIds: updatedRecordIds
            }
          );
        } else {
          // 如果没找到旧记录ID，追加新记录ID和URL
          await this.etsyOrderRepository.update(
            { orderId: order.etsyOrder.orderId },
            { 
              stampImageUrls: [...currentStampUrls, result.path],
              stampGenerationRecordIds: [...currentRecordIds, result.recordId]
            }
          );
        }
      } else if (result.recordId) {
        // 没有提供oldRecordId，追加新记录ID和URL
        await this.etsyOrderRepository.update(
          { orderId: order.etsyOrder.orderId },
          { 
            stampImageUrls: [...currentStampUrls, result.path],
            stampGenerationRecordIds: [...currentRecordIds, result.recordId]
          }
        );
      } else {
        // 如果没有记录ID，只更新最新的URL（追加）
        await this.etsyOrderRepository.update(
          { orderId: order.etsyOrder.orderId },
          { 
            stampImageUrls: [...currentStampUrls, result.path]
          }
        );
      }
      
      // 更新订单状态为已生成印章待审核
      await this.ordersRepository.update(
        { id: order.id },
        { status: 'stamp_generated_pending_review' }
      );

      return {
        success: true,
        path: result.path,
        recordId: result.recordId
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getOrderStampRecords(orderId: string) {
    // 首先确认订单存在
    const order = await this.ordersRepository.findOne({
      where: { id: orderId }
    });

    if (!order) {
      throw new NotFoundException(`Order with ID ${orderId} not found`);
    }

    // 从StampService获取记录
    return this.stampsService.getGenerationRecordsByOrderId(orderId);
  }

  async exportStampsAsZip(startDate?: string, endDate?: string, search?: string, status?: string): Promise<{
    filePath: string;
    fileName: string;
    orderCount: number;
  }> {
    console.log(`开始导出图章: 开始日期=${startDate || '无'}, 结束日期=${endDate || '无'}, 搜索=${search || '无'}, 状态=${status || '全部'}`);
    
    // Create query builder for finding orders with generated stamps
    const queryBuilder = this.ordersRepository.createQueryBuilder('order')
      .leftJoinAndSelect('order.etsyOrder', 'etsyOrder');

    // Apply status filter if provided, otherwise use default filter for generated stamps
    if (status) {
      queryBuilder.where('order.status = :status', { status });
    } else {
      queryBuilder.where('order.status IN (:...statuses)', { 
        statuses: ['stamp_generated_pending_review', 'stamp_generated_reviewed'] 
      });
    }

    // Apply date filters
    this.applyDateFilters(queryBuilder, startDate, endDate);

    // Apply search filter if provided
    if (search) {
      queryBuilder.andWhere(
        '(etsyOrder.orderId LIKE :search OR CAST(order.id as TEXT) LIKE :search OR order.platformOrderId LIKE :search OR order.searchKey ILIKE :search)',
        { search: `%${search}%` }
      );
    }

    // Get the SQL query for debugging
    const sqlQuery = queryBuilder.getSql();
    console.log(`查询SQL: ${sqlQuery}`);
    
    // Also log the parameters
    const sqlParams = queryBuilder.getParameters();
    console.log(`查询参数: ${JSON.stringify(sqlParams)}`);

    // First, let's check all orders with their dates, without filtering
    const allOrdersQuery = this.ordersRepository.createQueryBuilder('order')
      .leftJoinAndSelect('order.etsyOrder', 'etsyOrder');
      
    // If status is provided, use it for the check query as well
    if (status) {
      allOrdersQuery.where('order.status = :status', { status });
    } else {
      allOrdersQuery.where('order.status IN (:...statuses)', { 
        statuses: ['stamp_generated_pending_review', 'stamp_generated_reviewed'] 
      });
    }
    
    const allOrders = await allOrdersQuery.getMany();
    console.log(`总共找到 ${allOrders.length} 个状态符合的订单`);
    for (const order of allOrders) {
      console.log(`订单ID: ${order.id}, 创建时间: ${order.createdAt}`);
    }

    // Find all relevant orders with date filtering
    const orders = await queryBuilder.getMany();
    
    if (orders.length === 0) {
      throw new NotFoundException('没有找到符合条件的订单');
    }

    console.log(`找到 ${orders.length} 个订单需要导出`);

    // Create output directory if it doesn't exist
    const exportDir = path.join(process.cwd(), this.exportsOutputDir);
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    // Create a new zip file
    const zip = new AdmZip();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `stamps_export_${timestamp}.zip`;
    const filePath = path.join(exportDir, fileName);
    
    console.log(`将创建压缩包: ${filePath}`);

    // First, generate the Excel file with order information
    try {
      // Create Excel file with order info
      const excelFilePath = await this.excelService.createOrdersExcelForExport(orders);
      
      // Add Excel file to the zip
      if (fs.existsSync(excelFilePath)) {
        zip.addLocalFile(excelFilePath, '', 'orders_info.xlsx');
        console.log(`已添加订单信息Excel文件到压缩包`);
      } else {
        console.log(`警告: 无法找到订单信息Excel文件: ${excelFilePath}`);
      }
    } catch (error) {
      console.error(`生成Excel文件时出错: ${error.message}`);
      // Continue even if Excel file generation fails
    }

    // Keep track of files added to the zip
    let addedFilesCount = 0;

    // Process each order
    for (let i = 0; i < orders.length; i++) {
      try {
        const order = orders[i];
        console.log(`处理订单 ${order.id} (platformOrderId: ${order.platformOrderId || 'N/A'})`);
        
        // 首先检查关联的 EtsyOrder 是否存在且有 stampImageUrls
        if (order.etsyOrder && order.etsyOrder.stampImageUrls && order.etsyOrder.stampImageUrls.length > 0) {
          console.log(`订单 ${order.id} 有关联的 EtsyOrder, stampImageUrls: ${JSON.stringify(order.etsyOrder.stampImageUrls)}`);
          
          // 获取最新的印章URL（数组的最后一个元素）
          const latestStampUrl = order.etsyOrder.stampImageUrls[order.etsyOrder.stampImageUrls.length - 1];
          
          // Get absolute path to the stamp file
          let relativePath = latestStampUrl.startsWith('/') 
            ? latestStampUrl.substring(1) 
            : latestStampUrl;
          
          // If the path doesn't already include uploads/stamps, use the stampsOutputDir
          if (!relativePath.includes('uploads/stamps')) {
            // Extract just the filename from the path
            const fileName = path.basename(relativePath);
            relativePath = path.join(this.stampsOutputDir, fileName);
          }
          
          const stampPath = path.join(process.cwd(), relativePath);
          
          console.log(`检查文件路径: ${stampPath}, 存在: ${fs.existsSync(stampPath)}`);
          
          if (fs.existsSync(stampPath)) {
            // 获取文件大小
            const stats = fs.statSync(stampPath);
            console.log(`文件大小: ${stats.size} 字节`);
            
            if (stats.size === 0) {
              console.log(`警告: 文件 ${stampPath} 大小为0`);
              continue;
            }
            
            // Use index number (1-based) as filename with original extension
            const fileExtension = path.extname(stampPath);
            const numberedFileName = `${i + 1}${fileExtension}`;
            
            console.log(`添加文件到压缩包: ${numberedFileName}`);
            
            // Add the file to the zip
            zip.addLocalFile(stampPath, '', numberedFileName);
            addedFilesCount++;
          } else {
            console.log(`错误: 文件不存在 ${stampPath}`);
          }
        } else {
          console.log(`订单 ${order.id} 没有关联的 EtsyOrder 或没有 stampImageUrls`);
        }
      } catch (error) {
        console.error(`处理订单时发生错误:`, error);
        // Continue with other orders even if one fails
      }
    }

    if (addedFilesCount === 0) {
      throw new NotFoundException('未找到任何有效的图章文件。请检查文件是否存在。');
    }

    console.log(`写入压缩文件，共有 ${addedFilesCount} 个图章`);
    
    // Save the zip file
    zip.writeZip(filePath);
    
    console.log(`压缩文件已保存到: ${filePath}`);

    return {
      filePath,
      fileName,
      orderCount: addedFilesCount
    };
  }
} 