import { Injectable, Logger } from '@nestjs/common';
import { read, utils, write, WorkSheet, WorkBook } from 'xlsx';
import { OrderStampService } from '../../stamps/services/order-stamp.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../entities/order.entity';
import { EtsyOrder } from '../entities/etsy-order.entity';
import { v4 as uuidv4 } from 'uuid';
import { JobQueueService } from '../../common/services/job-queue.service';
import * as path from 'path';
import * as fs from 'fs';
import { User } from '../../users/entities/user.entity';
import { AliyunService } from 'src/common/services/aliyun.service';
import { OrderStatus, OrderType } from '../enums/order.enum';

type ProcessingResult = {
  total: number;
  created: number;
  skipped: number;
  skippedReasons: { orderId: string; transactionId: string; reason: string }[];
  failed: number;
  stamps: { orderId: string; transactionId: string; stampPath: string }[];
};

@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);

  constructor(
    private readonly orderStampService: OrderStampService,
    private readonly jobQueueService: JobQueueService,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(EtsyOrder)
    private readonly etsyOrderRepository: Repository<EtsyOrder>,
    private readonly aliyunService: AliyunService,
  ) {}

  /**
   * Process Excel file asynchronously with progress tracking
   */
  async processExcelFileAsync(file: Express.Multer.File, user?: User): Promise<string> {
    const jobId = this.jobQueueService.createJob(user?.id);
    
    this.processExcelFileWithProgress(file, jobId, user).catch(error => {
      this.logger.error(`Error in background processing: ${error.message}`, error.stack);
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'failed',
        progress: 100,
        message: `Failed to process file: ${error.message}`,
        error: error.message
      });
    });
    
    return jobId;
  }

  /**
   * Create Excel file for exporting orders
   */
  async createOrdersExcelForExport(orders: Order[]): Promise<string> {
    try {
      const excelData = this.prepareOrdersExportData(orders);
      return this.generateExcelFile(excelData);
    } catch (error) {
      this.logger.error(`Failed to create Excel file: ${error.message}`, error.stack);
      throw new Error(`Failed to create Excel file: ${error.message}`);
    }
  }

  /**
   * Parse order variations using LLM
   */
  public async parseVariations(variationsString: string, templateDescription?: string): Promise<{
    variations: { [key: string]: string };
    hasMultiple: boolean;
    personalizations: Array<Array<{ id: string; value: string }>>;
    originalVariations: string;
  }> {
    if (!variationsString) {
      return {
        variations: null,
        hasMultiple: false,
        personalizations: [],
        originalVariations: ''
      };
    }
    
    try {
      const prompt = this.buildParsingPrompt();
      const userPrompt = this.buildUserPrompt(variationsString, templateDescription);

      try {
        const parsedResult = await this.aliyunService.generateJson(userPrompt, { systemPrompt: prompt });
        this.logger.log(`Parsed result: ${JSON.stringify(parsedResult)}`);
        return {
          ...parsedResult,
          originalVariations: variationsString
        };
      } catch (jsonError) {
        this.logger.warn(`Failed to parse variations using GLM JSON: ${jsonError.message}`);
        throw new Error(`Failed to parse variations: ${jsonError.message}`);
      }
    } catch (error) {
      this.logger.error(`Error parsing variations using LLM: ${error.message}`, error);
      throw error;
    }
  }

  /**
   * Process Excel file with progress tracking
   */
  private async processExcelFileWithProgress(file: Express.Multer.File, jobId: string, user?: User): Promise<void> {
    try {
      // Initial progress update
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'processing',
        progress: 5,
        message: 'Reading Excel file...'
      });

      // Read and process the data
      const { data, result } = await this.readAndProcessExcelData(file, jobId, user);

      // Complete the job
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'completed',
        progress: 100,
        message: `Completed processing ${data.length} orders`,
        result
      });
      
      // Set cleanup timeout for this job
      this.jobQueueService.startJobCleanup(jobId);
      
    } catch (error) {
      this.logger.error(`Failed to process Excel file: ${error.message}`, error.stack);
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'failed',
        progress: 100,
        message: `Failed to process file: ${error.message}`,
        error: error.message
      });
    }
  }

  /**
   * Read Excel file and process its data
   */
  private async readAndProcessExcelData(
    file: Express.Multer.File, 
    jobId?: string, 
    user?: User
  ): Promise<{ 
    data: any[]; 
    result: ProcessingResult;
  }> {
    // Read Excel file
    const workbook = read(file.buffer, { type: 'buffer' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = utils.sheet_to_json(worksheet);

    if (jobId) {
      this.jobQueueService.updateJobProgress(jobId, {
        progress: 10,
        message: `Found ${data.length} orders to process`
      });
    }

    // Initialize processing results
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const stamps: { orderId: string; transactionId: string; stampPath: string }[] = [];
    const skippedReasons: { orderId: string; transactionId: string; reason: string }[] = [];

    // Process each order
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      
      if (jobId) {
        const progressPercentage = 10 + Math.floor((i / data.length) * 85);
        this.jobQueueService.updateJobProgress(jobId, {
          progress: progressPercentage,
          message: `Processing order ${i+1} of ${data.length}...`
        });
      }

      try {
        const { orderId, transactionId, validationError } = this.validateOrderData(item);
        
        if (validationError) {
          skipped++;
          skippedReasons.push({
            orderId: orderId || 'Unknown',
            transactionId: transactionId || 'Unknown',
            reason: validationError
          });
          continue;
        }

        // Process order and generate stamp
        const orderResult = await this.processOrderWithStamp(item, user);
        
        if (orderResult.success && orderResult.stamps && orderResult.stamps.length > 0) {
          created += orderResult.stamps.length;
          stamps.push(...orderResult.stamps);
          this.logger.log(`Successfully processed order ${orderId} with ${orderResult.stamps.length} personalizations`);
        } else {
          skipped++;
          skippedReasons.push({
            orderId,
            transactionId,
            reason: orderResult.error || 'Unknown error during order processing'
          });
        }
      } catch (error) {
        this.logger.error(`Failed to process order:`, error);
        failed++;
        const orderId = item['Order ID']?.toString() || 'Unknown';
        const transactionId = item['Transaction ID']?.toString() || 'Unknown';
        skippedReasons.push({
          orderId,
          transactionId,
          reason: error.message
        });
      }
    }

    // Return processing results
    return {
      data,
      result: {
        total: data.length,
        created,
        skipped,
        skippedReasons,
        failed,
        stamps
      }
    };
  }

  /**
   * Validate order data from Excel
   */
  private validateOrderData(item: any): {
    orderId: string;
    transactionId: string;
    validationError?: string;
  } {
    const orderId = item['Order ID']?.toString() || '';
    const transactionId = item['Transaction ID']?.toString() || '';
    
    if (!orderId) {
      return { orderId, transactionId, validationError: 'Order ID is required' };
    }
    
    if (!transactionId) {
      return { orderId, transactionId, validationError: 'Transaction ID is required' };
    }

    // Check if order with same Transaction ID exists
    return { orderId, transactionId };
  }

  /**
   * Process order and generate stamp
   */
  private async processOrderWithStamp(
    item: any, 
    user?: User,
    personalizationText?: string
  ): Promise<{
    success: boolean;
    stamps?: Array<{ orderId: string; transactionId: string; stampPath: string }>;
    error?: string;
  }> {
    const orderId = item['Order ID']?.toString() || '';
    const baseTransactionId = item['Transaction ID']?.toString() || '';
    
    if (!orderId || !baseTransactionId) {
      return {
        success: false,
        error: 'Missing order ID or transaction ID'
      };
    }

    // Check if order already exists
    const existingOrder = await this.etsyOrderRepository.findOne({
      where: { transactionId: baseTransactionId }
    });

    if (existingOrder) {
      return {
        success: false,
        error: 'Order with this Transaction ID already exists'
      };
    }
    
    try {
      // Find template for the SKU
      const { templateDescription, error: templateError } = await this.findTemplateDescription(item);
      
      if (templateError) {
        return { success: false, error: templateError };
      }
      
      // Parse variations
      const originalVariations = personalizationText || item['Variations'];
      
      if (!originalVariations) {
        return {
          success: false,
          error: 'No variations data found in order'
        };
      }
      
      const parsedResult = await this.parseVariations(originalVariations, templateDescription);
      
      // Generate stamp
      return await this.generateStamp(item, parsedResult, baseTransactionId, user);
      
    } catch (error) {
      this.logger.error(`Error processing order with stamp: ${error.message}`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Find template description for an order
   */
  private async findTemplateDescription(item: any): Promise<{
    templateDescription?: string;
    error?: string;
  }> {
    const sku = item['SKU']?.toString();
    const orderId = item['Order ID']?.toString() || '';
    
    if (!sku) {
      this.logger.warn(`Order ${orderId} has no SKU, cannot find matching template`);
      return { error: 'Order has no SKU information, cannot find matching template' };
    }
    
    // Extract base part of SKU (e.g., from "AD-110-XX" to "AD-110")
    const skuBase = sku.split('-').slice(0, 2).join('-');
    
    try {
      const templates = await this.orderStampService.findTemplatesBySku(sku, skuBase);
      
      if (!templates || templates.length === 0) {
        this.logger.warn(`No template found for SKU ${sku}`);
        return { error: `No matching template found for SKU: ${sku}` };
      }
      
      const template = templates[0];
      
      // Build template description from text elements
      const descriptionParts = [];
      
      if (template.textElements && template.textElements.length > 0) {
        template.textElements.forEach(element => {
          descriptionParts.push({
            id: element.id,
            description: element.description,
            defaultValue: element.defaultValue
          });
        });
      }
      
      const templateDescription = JSON.stringify(descriptionParts);
      this.logger.log(`Found template description for SKU ${sku}: ${templateDescription}`);
      
      return { templateDescription };
      
    } catch (error) {
      this.logger.warn(`Could not find template description for SKU ${sku}: ${error.message}`);
      return { error: `Error finding template for SKU ${sku}: ${error.message}` };
    }
  }

  /**
   * Generate stamp for an order
   */
  private async generateStamp(
    item: any,
    parsedResult: any,
    baseTransactionId: string,
    user?: User
  ): Promise<{
    success: boolean;
    stamps?: Array<{ orderId: string; transactionId: string; stampPath: string }>;
    error?: string;
  }> {
    const orderId = item['Order ID']?.toString() || '';
    
    // Create temporary order ID
    const tempOrderId = uuidv4();
    
    // Create shared order record
    const stamps: Array<{ orderId: string; transactionId: string; stampPath: string }> = [];
    
    // Create basic order
    const order = this.orderRepository.create({
      status: OrderStatus.STAMP_NOT_GENERATED,
      orderType: OrderType.ETSY,
      platformOrderId: orderId,
      user: user,
      userId: user?.id
    });
    
    // Save the order to get its ID
    await this.orderRepository.save(order);
    
    // Create and save the EtsyOrder entity with shipping information
    const etsyOrder = this.etsyOrderRepository.create({
      orderId,
      transactionId: baseTransactionId,
      order: order,
      sku: item['SKU']?.toString(),
      variations: parsedResult.variations,
      originalVariations: parsedResult.originalVariations,
      stampImageUrls: [],
      stampGenerationRecordIds: [],
      // Shipping information
      shipName: item['Ship Name']?.toString(),
      shipAddress1: item['Ship Address1']?.toString(),
      shipAddress2: item['Ship Address2']?.toString(),
      shipCity: item['Ship City']?.toString(),
      shipState: item['Ship State']?.toString(),
      shipZipcode: item['Ship Zipcode']?.toString(),
      shipCountry: item['Ship Country']?.toString(),
      // Order details
      itemName: item['Item Name']?.toString(),
      listingId: item['Listing ID']?.toString(),
      buyer: item['Buyer']?.toString(),
      quantity: item['Quantity'] ? Number(item['Quantity']) : null,
      price: item['Price'] ? Number(item['Price']) : null,
      datePaid: item['Date Paid'] ? new Date(item['Date Paid']) : null,
      saleDate: item['Sale Date'] ? new Date(item['Sale Date']) : null,
      currency: item['Currency']?.toString(),
      couponCode: item['Coupon Code']?.toString(),
      couponDetails: item['Coupon Details']?.toString(),
      discountAmount: item['Discount Amount'] ? Number(item['Discount Amount']) : null,
      shippingDiscount: item['Shipping Discount'] ? Number(item['Shipping Discount']) : null,
      orderShipping: item['Order Shipping'] ? Number(item['Order Shipping']) : null,
      orderSalesTax: item['Order Sales Tax'] ? Number(item['Order Sales Tax']) : null,
      itemTotal: item['Item Total'] ? Number(item['Item Total']) : null,
      vatPaidByBuyer: item['VAT Paid by Buyer'] ? Number(item['VAT Paid by Buyer']) : null,
      orderType: item['Order Type']?.toString(),
      listingsType: item['Listings Type']?.toString(),
      paymentType: item['Payment Type']?.toString()
    });
    
    // Save the EtsyOrder to get its ID
    await this.etsyOrderRepository.save(etsyOrder);
    
    // Process each personalization group
    for (let i = 0; i < parsedResult.personalizations.length; i++) {
      const personalizationGroup = parsedResult.personalizations[i];
      
      // Create temporary EtsyOrder object for stamp generation
      const tempEtsyOrder = {
        orderId,
        transactionId: baseTransactionId,
        order_id: order.id,
        sku: item['SKU']?.toString(),
        variations: {
          ...parsedResult.variations,
          personalization: personalizationGroup.reduce((acc, curr) => {
            acc[curr.id] = curr.value;
            return acc;
          }, {})
        },
        originalVariations: parsedResult.originalVariations
      };
      
      this.logger.log(`Processing personalization group #${i + 1}: ${JSON.stringify(personalizationGroup)}`);
      
      // Generate stamp for this personalization group
      const stampResult = await this.orderStampService.generateStampFromOrder({
        order: tempEtsyOrder,
        convertTextToPaths: true
      });
      
      if (!stampResult.success) {
        this.logger.warn(`Failed to generate stamp for personalization group #${i + 1}: ${stampResult.error}`);
        continue; // Skip this group but continue with others
      }
      
      // Record generated stamp record ID and update EtsyOrder
      if (stampResult.recordId) {
        const stampPath = stampResult.path.replace('uploads/', '/');
        
        // Add to stamps result
        stamps.push({
          orderId: order.id,
          transactionId: baseTransactionId,
          stampPath
        });
        
        // Update the EtsyOrder with the stamp information
        etsyOrder.stampImageUrls = [...(etsyOrder.stampImageUrls || []), stampPath];
        etsyOrder.stampGenerationRecordIds = [...(etsyOrder.stampGenerationRecordIds || []), stampResult.recordId];
        
        // Save the updated EtsyOrder
        await this.etsyOrderRepository.save(etsyOrder);
      }
    }
    
    // Update order status if at least one stamp was generated
    if (stamps.length > 0) {
      await this.orderRepository.update(
        { id: order.id },
        { status: OrderStatus.STAMP_GENERATED_PENDING_REVIEW }
      );
    }
    
    this.logger.log(`Generated ${stamps.length} stamps for order ${orderId}`);
    
    return {
      success: stamps.length > 0,
      stamps: stamps.length > 0 ? stamps : undefined,
      error: stamps.length === 0 ? 'No stamps were generated for any personalization group' : undefined
    };
  }

  /**
   * Prepare data for exporting orders to Excel
   */
  private prepareOrdersExportData(orders: Order[]): any[] {
    const excelData = [];
    
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      
      if (order.orderType === 'etsy' && order.etsyOrder) {
        order.etsyOrder.stampImageUrls.forEach((stampUrl, stampIndex) => {
          excelData.push({
            '序号': `${i + 1}-${stampIndex + 1}`,
            '订单号': order.etsyOrder.orderId,
            'SKU': order.etsyOrder.sku || 'N/A',
            '解析前的variants': order.etsyOrder.originalVariations || 'N/A',
            '解析后的variants': JSON.stringify(order.etsyOrder.variations) || 'N/A',
            '下单日期': order.platformOrderDate || order.createdAt,
            '文件名': `${order.platformOrderId}-${stampIndex + 1}${path.extname(stampUrl)}`
          });
        });
      }
    }
    
    return excelData;
  }

  /**
   * Generate Excel file from data
   */
  private generateExcelFile(excelData: any[]): string {
    // Create workbook and worksheet
    const worksheet: WorkSheet = utils.json_to_sheet(excelData);
    const workbook: WorkBook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, '订单信息');
    
    // Set column widths
    worksheet['!cols'] = [
      { wch: 10 },  // 序号
      { wch: 20 },  // 订单号
      { wch: 15 },  // SKU
      { wch: 40 },  // 解析前的variants
      { wch: 40 },  // 解析后的variants
      { wch: 20 },  // 下单日期
      { wch: 15 },  // 文件名
    ];
    
    // Create output directory
    const exportDir = path.join(process.cwd(), 'uploads', 'exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    
    // Create file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const excelFileName = `orders_info_${timestamp}.xlsx`;
    const excelFilePath = path.join(exportDir, excelFileName);
    
    const excelBuffer = write(workbook, { bookType: 'xlsx', type: 'buffer' });
    fs.writeFileSync(excelFilePath, excelBuffer);
    
    this.logger.log(`Excel file created at: ${excelFilePath}`);
    
    return excelFilePath;
  }

  /**
   * Build prompt for parsing variations
   */
  private buildParsingPrompt(): string {
    return `
你是一位解析订单的专家。你需要完成两个任务：
1. 将原始的变量字符串解析为JSON格式
2. 分析是否包含多个个性化信息，并将每个个性化信息根据模板描述 (description) 解析为结构化数据

请按照以下格式返回JSON:
{
  "variations": {
    "字段名1": "值1",
    "字段名2": "值2",
    ...
  },
  "hasMultiple": true/false, // 是否包含多个 Personalization 信息
  "personalizations": [    // 每个 Personalization 的结构化数据
    [
      {
        "id": "id_1",
        "value": "值1"
      },
      {
        "id": "id_2",
        "value": "值2"
      },
      ...
    ],
    ... // 可能还有更多个性化信息
  ]
}

特别注意:
1. 个性化信息 (personalizations) 是最重要的字段，必须确保100%完整保留，尤其是地址、名称等信息
2. 如果只有一个个性化信息，hasMultiple 应为 false
3. 保持原始文本的精确性，不要添加或删除内容
4. 一定要保证填写每一个字段，根据模版字段的描述 (description) 来匹配信息应该填写到哪个字段
5. 仅输出JSON对象，不要有任何其他文本

注意！！！每个结构化数据的 key-value 的 key 是模版描述中的 id (不要自己编造，严格按照模版描述中的 id)！！！

例如，对于如下原始变量:
"Stamp Type:Wood Stamp + ink pad,Design Options:#4,Personalization:The Bradys
50 South Circle V Drive
Manila, UT 84046"

以及如下模版:
[
  {"id":"name","description":"名字或团体名称","defaultValue":"default"},
  {"id":"address_line1","description":"地址栏一","defaultValue":"address1"},
  {"id":"address_line2","description":"地址栏二","defaultValue":"address2"},
  ... // 可能还有更多字段
]

正确的解析应为如下:
{
  "variations": {
    "Stamp Type": "Wood Stamp + ink pad",
    "Design Options": "#4"
  },
  "hasMultiple": false,
  "personalizations": [
    [
      {
        "id": "name",
        "value": "The Bradys"
      },
      {
        "id": "address_line1",
        "value": "50 South Circle V Drive"
      },
      {
        "id": "address_line2",
        "value": "Manila, UT 84046"
      }
    ]
  ]
}
`;
  }

  /**
   * Build user prompt for parsing variations
   */
  private buildUserPrompt(variationsString: string, templateDescription?: string): string {
    return `${templateDescription ? `
模版如下，请根据模版字段的描述 (description) 来理解和提取相关字段：
${templateDescription}
` : ''}

原始变量字符串:
${variationsString}`;
  }

  async updateOrderStatus(orderId: string, status: OrderStatus) {
    await this.orderRepository.update(
      { id: orderId },
      { status: status }
    );
  }
} 