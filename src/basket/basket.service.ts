import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import * as fs from 'fs';
import { read, utils, write, writeFile } from 'xlsx';
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
import { CreateSkuConfigDto } from './dto/sku-config.dto';
import { AliyunService } from 'src/common/services/aliyun.service';
import { RemoteAreaService } from 'src/common/services/remote-area.service';

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
  isRemoteArea?: boolean;
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
    
    // 使用模糊匹配，只要配置的 SKU 是订单 SKU 的一部分就匹配
    const matchingConfig = skuConfigs.find(config => sku.includes(config.sku));
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
          const shipState = row['Ship State'] || row['省/州'] || '';
          
          // 使用dayjs格式化日期
          const formattedDatePaid = this.formatExcelDate(datePaid);
          
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
          const skuConfig = skuConfigs.find(config => sku.includes(config.sku));
          
          // Replace the matched part while preserving the rest
          let replacedSku = sku;
          if (skuConfig) {
            const matchedIndex = sku.indexOf(skuConfig.sku);
            if (matchedIndex !== -1) {
              replacedSku = sku.slice(0, matchedIndex) + 
                           skuConfig.replaceValue + 
                           sku.slice(matchedIndex + skuConfig.sku.length);
            }
          }
          
          // 保存数据行号（注意：第一行是标题行，不包含在rawData中）
          // 因此实际的Excel行号需要加2（1是因为Excel从1开始，再加1是因为标题行）
          const excelRowIndex = i + 2;
          
          // Map the row data to our order structure
          const orderData: ProcessedOrder = {
            id: excelRowIndex, // 使用正确的Excel行号
            quantity,
            orderId,
            shipName,
            variations: analyzedVariations,
            sku: replacedSku,
            orderType,
            fontSize: skuConfig?.fontSize,
            font: skuConfig?.font,
            datePaid: formattedDatePaid,
            isRemoteArea: this.remoteAreaService.isRemoteArea(shipState),
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
      // 如果是数字或可以转换为数字的字符串
      const numDate = Number(excelDate);
      if (!isNaN(numDate) && numDate > 10000) {
        // Excel日期是从1900-01-01开始的天数（有一天的误差）
        const excelBaseDate = dayjs('1900-01-01');
        // 转换Excel序列号为日期
        const date = excelBaseDate.add(numDate - 1, 'day');
        
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
    orderType: 'basket' | 'backpack' | 'all'
  ): Promise<void> {
    // Declare file paths outside the try block so they're available in catch block
    let modifiedExcelPath: string | null = null; // Declare modifiedExcelPath here
    let pptFilePath: string | null = null;
    let zipFilePath: string | null = null;
    
    try {
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

      // Read the file from disk - workbook is already read using xlsx
      const fileBuffer = fs.readFileSync(file.path);
      const workbook = read(fileBuffer, { type: 'buffer' }); // Use the initially read workbook
      // const worksheet = workbook.Sheets[workbook.SheetNames[0]]; // worksheet obtained below
      // const rawData = utils.sheet_to_json(worksheet, { header: 'A' }); // rawData not needed here again
      
      // Process the data and keep track of processed row indices
      const processedOrders = await this.processExcelData(fileBuffer, skuConfigs);
      
      // Filter orders based on orderType, unless it's 'all'
      const filteredOrders = orderType === 'all' 
          ? processedOrders // Include all processed orders if type is 'all'
          : processedOrders.filter(order => order.orderType === orderType); // Filter by specific type otherwise
      
      // Check if any orders were found
      if (filteredOrders.length === 0) {
        let errorMessage = '';
        if (orderType === 'all') {
          errorMessage = '没有找到任何与您已配置的SKU匹配的订单，请检查您的SKU配置是否正确';
        } else {
          errorMessage = `没有找到匹配的${orderType === 'basket' ? '篮子' : '书包'}订单，请检查您的SKU配置是否正确`;
        }
        throw new Error(errorMessage);
      }
      
      // --- Start: Modify Excel using xlsx ---
      this.logger.debug('Adding "Processed" column to Excel file using xlsx');
      
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const validRowIds = new Set(filteredOrders.map(order => order.id));
      
      // 1. Determine new column index and header cell
      const range = utils.decode_range(worksheet['!ref']);
      const newColIndex = (range.e.c || 0) + 1; // 0-indexed new column
      const headerCellAddress = utils.encode_cell({ r: 0, c: newColIndex }); // Header at first row (index 0)
      
      // 2. Add Header
      worksheet[headerCellAddress] = { v: 'Processed', t: 's' }; // 's' for string type
      
      // 3. Add Data Markers
      let processedCount = 0;
      for (let R = 1; R <= range.e.r; ++R) { // Iterate data rows (starting index 1)
        const excelRowNumber = R + 1; // Excel row number is 1-based index + 1
        if (validRowIds.has(excelRowNumber)) {
          const dataCellAddress = utils.encode_cell({ r: R, c: newColIndex });
          worksheet[dataCellAddress] = { v: true, t: 'b' }; // Use boolean 'true', type 'b'
          processedCount++;
        }
      }
      this.logger.debug(`Marked ${processedCount} rows in new 'Processed' column.`);
      
      // 4. Update Sheet Range to include the new column
      range.e.c = newColIndex;
      worksheet['!ref'] = utils.encode_range(range);
      
      // 5. Define path and save modified Excel file
      const modifiedExcelFileName = `processed_${path.basename(file.originalname)}`;
      const modifiedExcelPath = path.join(this.uploadsDir, modifiedExcelFileName);
      // Use writeFile from xlsx library
      writeFile(workbook, modifiedExcelPath); 
      this.logger.debug(`Saved modified Excel with 'Processed' column to: ${modifiedExcelPath}`);
      // --- End: Modify Excel using xlsx ---

      // Remove the exceljs highlighting block previously here

      // Declare pptFilePath and zipFilePath (moved declaration earlier)
      // let highlightedExcelPath: string | null = null; // No longer needed
      let pptFilePath: string | null = null;
      let zipFilePath: string | null = null; // Physical path for zip creation

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
      
      const shopName = record?.user?.shopName || '';
      
      // Prepare data for PPT generation
      const pptData = this.preparePPTData(filteredOrders, shopName);
      
      // Call Python service to generate PPT
      const result = await this.pythonBasketService.generateBasketOrderPPT(
        Buffer.from(JSON.stringify(pptData)).toString('base64')
      );

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
      this.logger.error(`Error generating order package for record #${recordId}: ${error.message}`);

      // Clean up any temporary files that might have been created
      this.safeDeleteFile(modifiedExcelPath); // Use modifiedExcelPath
      this.safeDeleteFile(pptFilePath);
      
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
          color: variation.color || '',
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
          datePaid: order.datePaid || '',
          isRemoteArea: order.isRemoteArea || false,
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
你是一个订单变量解析专家，需要从变量中提取客户定制的每一项内容，用JSON数组格式返回，每个元素包含：
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
你是一个订单变量解析专家，需要从变量中提取客户定制的内容，用JSON数组格式返回，每个元素包含：
[
  {
    "color": 变量中提到的颜色（如毛线颜色、材料颜色等）,
    "icon": 变量中提到的背包图案编号,
    "value": 变量中客户要定制的内容（如名字、文字等）
  },
  ... // 可能还有更多定制项
]

请注意！！！
1. 不要编造任何信息，并且 100% 完整保留客户定制的内容。
2. 注意客户的定制内容会以 名字, 图案编号 的格式出现，客户的颜色定制内容一般会跟在 Yarn Color: 后面, 例如：
Yarn Color: Cream, Personalization: Branko, zd
返回结果: { "color": "Cream", "icon": "zd", "value": "Branko" } 
3. 客户的名字一定不是阿拉伯数字！！！
4. 请确保返回有效的 JSON 格式数组！！！没有额外的文本！！！
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