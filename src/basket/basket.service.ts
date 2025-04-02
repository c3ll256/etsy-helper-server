import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import * as fs from 'fs';
import { read, utils } from 'xlsx';

import { BasketGenerationRecord } from './entities/basket-generation-record.entity';
import { PythonBasketService } from './services/python-basket.service';
import { BasketGenerationResponseDto } from './dto/basket-generation-response.dto';
import { User } from '../users/entities/user.entity';
import { BasketPaginationDto } from './dto/basket-pagination.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { JobQueueService } from '../common/services/job-queue.service';
import { SkuConfig } from './entities/sku-config.entity';
import { CreateSkuConfigDto } from './dto/sku-config.dto';
import { AliyunService } from 'src/common/services/aliyun.service';

interface ParsedVariation {
  color: string;
  value: string;
  icon?: string;
  design?: string;
  originalText?: string;
}

interface ProcessedOrder {
  id: number;
  quantity: number;
  orderId: string;
  shipName: string;
  variations: ParsedVariation[];
  sku: string;
  orderType?: 'basket' | 'backpack';
  fontSize?: number;
  font?: string;
  datePaid?: string;
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
    private readonly pythonBasketService: PythonBasketService,
    private readonly jobQueueService: JobQueueService,
    private readonly aliyunService: AliyunService,
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
    orderType: 'basket' | 'backpack' = 'basket'
  ): Promise<BasketGenerationResponseDto> {
    // Check if user has SKU configuration
    const userConfigs = await this.getUserSkuConfigs(user.id);
    
    if (!userConfigs.length) {
      throw new BadRequestException('您尚未配置SKU匹配规则，请先前往设置页面进行配置');
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
      orderType: orderType // 在响应中包含订单类型
    };
  }

  /**
   * Get user's SKU configurations
   * @param userId User ID
   * @returns Array of user's SKU configurations
   */
  async getUserSkuConfigs(userId: string): Promise<SkuConfig[]> {
    return this.skuConfigRepository.find({ 
      where: { userId },
      order: { createdAt: 'DESC' }
    });
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
   * Determine order type based on SKU and user configuration
   * @param sku SKU from Excel
   * @param skuConfigs User's SKU configurations
   * @returns Order type ('basket', 'backpack', or undefined if no match)
   */
  private determineOrderType(sku: string, skuConfigs: SkuConfig[]): 'basket' | 'backpack' | undefined {
    if (!sku) return undefined;
    
    const matchingConfig = skuConfigs.find(config => config.sku === sku);
    if (matchingConfig) {
      return matchingConfig.type;
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
          const sku = row['SKU'] || '';
          const datePaid = row['Date Paid'] || row['付款日期'] || '';
          
          // Determine order type based on SKU
          const orderType = this.determineOrderType(sku, skuConfigs);
          
          // If neither basket nor backpack SKU is matched, skip this order
          if (!orderType) {
            this.logger.debug(`Skipping row ${i + 1}: SKU ${sku} does not match any configured patterns`);
            continue;
          }
          
          // Use LLM to analyze variations based on order type
          const analyzedVariations = await this.analyzeVariations(variations, orderType);
          
          // Find matching SKU config for replacement value and font size
          const skuConfig = skuConfigs.find(config => config.sku === sku);
          
          // Map the row data to our order structure
          const orderData: ProcessedOrder = {
            id: i + 1, // Auto-increment ID
            quantity,
            orderId,
            shipName,
            variations: analyzedVariations,
            sku: skuConfig?.replaceValue || sku,
            orderType,
            fontSize: skuConfig?.fontSize,
            font: skuConfig?.font,
            datePaid
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
    orderType: 'basket' | 'backpack'
  ): Promise<void> {
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

    try {
      // Parse Excel data
      await this.basketRecordRepository.update(recordId, {
        progress: 20,
      });
      
      this.jobQueueService.updateJobProgress(jobId, {
        progress: 20,
        message: '解析Excel数据',
      });

      // Read the file from disk instead of using buffer
      const fileBuffer = fs.readFileSync(file.path);
      const processedOrders = await this.processExcelData(fileBuffer, skuConfigs);
      
      // Filter orders by specified orderType if needed
      const filteredOrders = processedOrders.filter(order => 
        !orderType || order.orderType === orderType
      );
      
      // Check if any orders were found
      if (filteredOrders.length === 0) {
        throw new Error(`没有找到匹配的${orderType === 'basket' ? '篮子' : '书包'}订单，请检查您的SKU配置是否正确`);
      }
      
      // Update progress after processing Excel data
      await this.basketRecordRepository.update(recordId, {
        progress: 50,
        ordersProcessed: filteredOrders.length,
        totalOrders: filteredOrders.length,
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
      
      // 获取记录关联的用户信息
      const record = await this.basketRecordRepository.findOne({
        where: { id: recordId },
        relations: ['user']
      });
      
      // 从用户信息中获取店铺名称，如果不存在则使用空字符串
      const shopName = record?.user?.shopName || '';
      
      // Prepare data for PPT generation
      const pptData = this.preparePPTData(filteredOrders, shopName);
      
      // Call Python service to generate PPT
      const result = await this.pythonBasketService.generateBasketOrderPPT(
        Buffer.from(JSON.stringify(pptData)).toString('base64')
      );
      
      await this.basketRecordRepository.update(recordId, {
        progress: 90,
      });
      
      this.jobQueueService.updateJobProgress(jobId, {
        progress: 90,
        message: 'PPT生成完成，更新记录',
      });

      // Update record with the results
      await this.basketRecordRepository.update(recordId, {
        status: 'completed',
        progress: 100,
        outputFilePath: result.filePath,
        ordersProcessed: filteredOrders.length,
        totalOrders: filteredOrders.length,
      });
      
      // Update job progress with success result
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'completed',
        progress: 100,
        message: `${orderType === 'basket' ? '篮子' : '书包'}订单PPT生成成功`,
        result: {
          filePath: result.filePath,
          totalOrders: filteredOrders.length,
        }
      });

      this.logger.log(`Successfully generated basket orders PPT for record #${recordId}`);
      
      // Start job cleanup after 3 hours
      this.jobQueueService.startJobCleanup(jobId, 3 * 60 * 60 * 1000);
    } catch (error) {
      this.logger.error(`Error generating basket orders PPT for record #${recordId}: ${error.message}`);

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
        message: `${orderType === 'basket' ? '篮子' : '书包'}订单PPT生成失败`,
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
    
    // Process each order
    processedOrders.forEach(order => {
      // Calculate position for multi-buy orders (same orderID)
      const sameOrderIdOrders = processedOrders.filter(o => o.orderId === order.orderId);
      const totalOrderCount = sameOrderIdOrders.length;
      const orderPosition = sameOrderIdOrders.findIndex(o => o.id === order.id) + 1;
      const orderPositionString = `${orderPosition}/${totalOrderCount}`;
      
      // Process each variation in the order
      order.variations.forEach((variation, variationIndex) => {
        // For orders with multiple variations, calculate position
        const totalVariations = order.variations.length;
        const variationPosition = `${variationIndex + 1}/${totalVariations}`;
        
        // Create a slide for each variation
        const slideData = {
          date: new Date().toLocaleDateString('zh-CN'),
          orderNumber: String(order.orderId),
          color: variation.color || '默认颜色',
          icon: variation.icon || '', 
          position: totalOrderCount > 1 ? orderPositionString : variationPosition,
          recipientName: order.shipName || '',
          customName: variation.value || '',
          sku: order.sku || '',
          quantity: order.quantity || 1,
          shopName: shopName || '',
          orderType: order.orderType || 'basket',
          fontSize: order.fontSize,
          font: order.font, // 添加字体信息
          originalVariations: variation.originalText || '', // 添加原始变量文本
          datePaid: order.datePaid || ''
        };
        
        // 根据订单类型添加特定属性
        if (order.orderType === 'backpack') {
          // 为背包订单添加特定属性
          slideData['backpackStyle'] = true;
        }
        
        pptSlides.push(slideData);
      });
    });
    
    this.logger.debug(`Generated ${pptSlides.length} PPT slides with shop name: ${shopName}`);
    return pptSlides;
  }

  /**
   * Use LLM to analyze variations data based on order type
   * @param variations Variations string from Excel
   * @param orderType Type of order (basket or backpack)
   * @returns Array of parsed variations
   */
  private async analyzeVariations(variations: string, orderType: 'basket' | 'backpack'): Promise<ParsedVariation[]> {
    try {
      // Different prompt based on order type
      let prompt = '';
      
      if (orderType === 'basket') {
        prompt = `
你是一个订单变量解析专家，需要从篮子产品的变量中提取客户定制的每一项内容，用JSON数组格式返回，每个元素包含：
[
  {
    "color": 变量中提到的颜色信息（如毛线颜色、材料颜色等）,
    "value": 变量中客户要定制的内容（如名字、文字等）
  },
  ... // 可能还有更多定制项
]

请注意！！！
1. 如果有多个定制项，请分别提取并作为不同的数组元素返回。
2. 不要编造任何信息，并且 100% 完整保留客户定制的内容。
3. 注意阿拉伯数字一定不是 value！！！
4. 请确保返回有效的 JSON 格式数组！！！没有额外的文本！！！
`;
      } else if (orderType === 'backpack') {
        prompt = `
你是一个订单变量解析专家，需要从背包产品的变量中提取客户定制的内容，用JSON数组格式返回，每个元素包含：
[
  {
    "color": 变量中提到的羊毛颜色（Yarn Color）,
    "design": 变量中提到的背包设计信息（Backpack Design）,
    "icon": 变量中提到的背包图案编号（编号为数字）,
    "value": 变量中客户要定制的内容（如名字、文字等）
  },
  ... // 可能还有更多定制项
]

请注意！！！
1. 对于背包产品，通常会有背包颜色和定制内容两个部分。
2. 不要编造任何信息，并且 100% 完整保留客户定制的内容。
3. 注意 Personalization 中会包含客户的定制内容（英文词汇）以及定制的图案编号（阿拉伯数字），请分别提取。
4. 注意阿拉伯数字一定不是 value！！！
5. 请确保返回有效的 JSON 格式数组！！！没有额外的文本！！！
`;
      }

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
        color: '默认颜色',
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
      response.result = jobProgress.result;
    }
    
    // Add error if available
    if (jobProgress.error) {
      response.error = jobProgress.error;
    }
    
    return response;
  }
} 