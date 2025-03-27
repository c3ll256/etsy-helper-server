import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, Like } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { read, utils, write } from 'xlsx';
import { OllamaService } from '../common/services/ollama.service';

import { BasketGenerationRecord } from './entities/basket-generation-record.entity';
import { PythonBasketService } from './services/python-basket.service';
import { BasketGenerationResponseDto } from './dto/basket-generation-response.dto';
import { User } from '../users/entities/user.entity';
import { BasketPaginationDto } from './dto/basket-pagination.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';

interface ParsedOrder {
  orderId: string;
  orderNumber: string;
  product: string;
  color: string;
  icon: string;
  position: string;
  recipientName: string;
  customName: string;
  variations: Record<string, string>;
  sku: string;
}

@Injectable()
export class BasketService {
  private readonly logger = new Logger(BasketService.name);
  private readonly uploadsDir = 'uploads/baskets';

  constructor(
    @InjectRepository(BasketGenerationRecord)
    private readonly basketRecordRepository: Repository<BasketGenerationRecord>,
    private readonly pythonBasketService: PythonBasketService,
    private readonly ollamaService: OllamaService,
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
   * @returns Basket generation record
   */
  async generateBasketOrders(
    file: Express.Multer.File, 
    user: User,
    originalFilename?: string
  ): Promise<BasketGenerationResponseDto> {
    // Create a new record
    const record = this.basketRecordRepository.create({
      originalFilename: originalFilename || file.originalname,
      status: 'pending',
      progress: 0,
      userId: user.id,
    });

    // Save to get an ID
    const savedRecord = await this.basketRecordRepository.save(record);

    // Start processing in background
    this.processBasketOrdersAsync(savedRecord.id, file);

    // Return the record
    return {
      id: savedRecord.id,
      status: savedRecord.status,
      progress: savedRecord.progress,
      originalFilename: savedRecord.originalFilename,
      createdAt: savedRecord.createdAt,
    };
  }

  /**
   * Process Excel file to extract order data
   * @param excelBuffer Buffer containing Excel data
   * @returns Array of parsed order data
   */
  private async processExcelData(excelBuffer: Buffer): Promise<ParsedOrder[]> {
    try {
      // Read the Excel file
      const workbook = read(excelBuffer, { type: 'buffer' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = utils.sheet_to_json(worksheet);
      
      this.logger.log(`Processing ${rawData.length} rows from Excel file`);
      
      const parsedOrders: ParsedOrder[] = [];
      
      // Process each row
      for (let i = 0; i < rawData.length; i++) {
        const row = rawData[i];
        
        try {
          this.logger.debug(`Processing row ${i + 1}: ${JSON.stringify(row)}`);
          
          // Extract order ID, variations, and SKU
          const orderId = row['Order ID'] || row['OrderID'] || row['订单ID'] || '';
          const variations = row['Variations'] || row['变量'] || '';
          const sku = row['SKU'] || '';
          
          // Use LLM to analyze variations
          const analyzedData = await this.analyzeOrderData(orderId, variations, sku);
          
          // Map the row data to our order structure
          const orderData: ParsedOrder = {
            orderId: orderId,
            orderNumber: analyzedData.orderNumber || row['Order Number'] || row['订单号'] || '',
            product: analyzedData.product || row['Product'] || row['产品'] || '',
            color: analyzedData.color || row['Color'] || row['毛线颜色'] || '',
            icon: analyzedData.icon || row['Icon'] || row['图标'] || '',
            position: analyzedData.position || row['Position'] || row['一单多买的序号'] || '',
            recipientName: analyzedData.recipientName || row['Recipient Name'] || row['收件人姓名'] || '',
            customName: analyzedData.customName || row['Custom Name'] || row['定制名字'] || '',
            variations: analyzedData.parsedVariations || {},
            sku: sku
          };
          
          parsedOrders.push(orderData);
        } catch (error) {
          this.logger.error(`Error processing row ${i + 1}: ${error.message}`);
        }
      }
      
      return parsedOrders;
    } catch (error) {
      this.logger.error(`Error processing Excel data: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Use LLM to analyze order data
   * @param orderId Order ID from Excel
   * @param variations Variations string from Excel
   * @param sku SKU from Excel
   * @returns Analyzed data
   */
  private async analyzeOrderData(orderId: string, variations: string, sku: string): Promise<any> {
    try {
      const prompt = `
分析以下订单信息，并提取关键字段：

订单ID: ${orderId}
变量 (Variations): ${variations}
SKU: ${sku}

请分析并以JSON格式返回以下信息：
1. 订单号 (orderNumber): 从订单ID或变量中提取
2. 产品 (product): 从变量或SKU中提取产品类型
3. 毛线颜色 (color): 从变量中提取颜色信息
4. 图标 (icon): 从变量中提取图标信息，通常在"i12左下"这样的格式
5. 一单多买的序号 (position): 如有，通常是"1/2"这样的格式
6. 收件人姓名 (recipientName): 从变量中提取收件人姓名
7. 定制名字 (customName): 从变量中提取客户要求的定制名字
8. 解析的变量 (parsedVariations): 将所有变量解析为键值对格式

请确保返回有效的JSON格式，没有额外的文本。
`;

      const result = await this.ollamaService.generateJson(prompt, {
        temperature: 0.2, // Lower temperature for more deterministic results
      });
      
      this.logger.debug(`LLM analysis result: ${JSON.stringify(result)}`);
      
      return result;
    } catch (error) {
      this.logger.error(`Error analyzing order data with LLM: ${error.message}`);
      
      // Return empty object if LLM analysis fails
      return {
        orderNumber: '',
        product: '',
        color: '',
        icon: '',
        position: '',
        recipientName: '',
        customName: '',
        parsedVariations: {}
      };
    }
  }

  /**
   * Prepare order data for PPT generation
   * @param parsedOrders Parsed order data
   * @returns Base64 encoded PPT data
   */
  private async preparePPTData(parsedOrders: ParsedOrder[]): Promise<Buffer> {
    try {
      // Prepare data for Python script
      const jsonData = parsedOrders.map(order => ({
        date: new Date().toLocaleDateString('zh-CN'),
        orderNumber: order.orderNumber,
        product: order.product,
        color: order.color,
        icon: order.icon,
        position: order.position,
        recipientName: order.recipientName,
        customName: order.customName
      }));
      
      // Convert to base64 encoded JSON
      const excelData = Buffer.from(JSON.stringify(jsonData)).toString('base64');
      
      // Call Python service to generate PPT
      const result = await this.pythonBasketService.generateBasketOrderPPT(excelData);
      
      // Get the Buffer from the base64 data in the result
      const pptBuffer = Buffer.from(result.data, 'base64');
      
      return pptBuffer;
    } catch (error) {
      this.logger.error(`Error preparing PPT data: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process basket orders asynchronously
   * @param recordId Generation record ID
   * @param file Uploaded Excel file
   */
  private async processBasketOrdersAsync(recordId: number, file: Express.Multer.File): Promise<void> {
    // Update status to processing
    await this.basketRecordRepository.update(recordId, {
      status: 'processing',
      progress: 10,
    });

    try {
      // Parse Excel data in Node.js
      await this.basketRecordRepository.update(recordId, {
        progress: 20,
      });
      
      const parsedOrders = await this.processExcelData(file.buffer);
      
      await this.basketRecordRepository.update(recordId, {
        progress: 50,
        ordersProcessed: parsedOrders.length,
        totalOrders: parsedOrders.length,
      });

      // Generate PPT using Python service
      this.logger.log(`Generating PPT for ${parsedOrders.length} orders`);
      
      // Prepare data for generating PPT
      await this.basketRecordRepository.update(recordId, {
        progress: 60,
      });
      
      // Call Python service to generate PPT
      const result = await this.pythonBasketService.generateBasketOrderPPT(
        Buffer.from(JSON.stringify(parsedOrders)).toString('base64')
      );
      
      await this.basketRecordRepository.update(recordId, {
        progress: 90,
      });

      // Update record with the results
      await this.basketRecordRepository.update(recordId, {
        status: 'completed',
        progress: 100,
        outputFilePath: result.filePath,
        ordersProcessed: parsedOrders.length,
        totalOrders: parsedOrders.length,
      });

      this.logger.log(`Successfully generated basket orders PPT for record #${recordId}`);
    } catch (error) {
      this.logger.error(`Error generating basket orders PPT for record #${recordId}: ${error.message}`);

      // Update record with error
      await this.basketRecordRepository.update(recordId, {
        status: 'failed',
        progress: 0,
        errorMessage: error.message,
      });
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

    // Apply search filter if provided
    if (search) {
      queryBuilder.andWhere(
        '(record.originalFilename ILIKE :search)',
        { search: `%${search}%` }
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
} 