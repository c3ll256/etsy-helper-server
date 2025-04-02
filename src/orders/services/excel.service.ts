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

  // New method for asynchronous processing with progress tracking
  async processExcelFileAsync(file: Express.Multer.File, user?: User): Promise<string> {
    const jobId = this.jobQueueService.createJob(user?.id);
    
    // Start processing in background
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

  // Background processing method
  private async processExcelFileWithProgress(file: Express.Multer.File, jobId: string, user?: User): Promise<void> {
    try {
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'processing',
        progress: 5,
        message: 'Reading Excel file...'
      });

      const workbook = read(file.buffer, { type: 'buffer' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = utils.sheet_to_json(worksheet);

      this.jobQueueService.updateJobProgress(jobId, {
        progress: 10,
        message: `Found ${data.length} orders to process`
      });

      let created = 0;
      let skipped = 0;
      let failed = 0;
      const stamps: { orderId: string; transactionId: string; stampPath: string }[] = [];
      const skippedReasons: { orderId: string; transactionId: string; reason: string }[] = [];

      // Process each order
      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        const progressPercentage = 10 + Math.floor((i / data.length) * 85); // Progress from 10% to 95%
        
        this.jobQueueService.updateJobProgress(jobId, {
          progress: progressPercentage,
          message: `Processing order ${i+1} of ${data.length}...`
        });

        try {
          const orderId = item['Order ID']?.toString() || '';
          const transactionId = item['Transaction ID']?.toString() || '';
          
          if (!orderId) {
            skipped++;
            skippedReasons.push({ 
              orderId: 'Unknown', 
              transactionId: 'Unknown', 
              reason: 'Order ID is required' 
            });
            continue;
          }
          
          if (!transactionId) {
            skipped++;
            skippedReasons.push({ 
              orderId, 
              transactionId: 'Unknown', 
              reason: 'Transaction ID is required' 
            });
            continue;
          }

          // 检查是否存在相同的Transaction ID
          const existingOrder = await this.etsyOrderRepository.findOne({
            where: { transactionId }
          });

          if (existingOrder) {
            skipped++;
            skippedReasons.push({ 
              orderId, 
              transactionId, 
              reason: 'Order with this Transaction ID already exists' 
            });
            continue;
          }

          // 使用processOrderWithStamp处理订单，现在支持自动检测和处理多个个性化信息，并关联到用户
          const orderResult = await this.processOrderWithStamp(item, user);
          
          if (orderResult.success && orderResult.stamps && orderResult.stamps.length > 0) {
            // 成功创建了订单和印章
            created += orderResult.stamps.length;
            
            // 将所有生成的印章添加到结果中
            stamps.push(...orderResult.stamps);
            
            this.logger.log(`Successfully processed order ${orderId} with ${orderResult.stamps.length} personalizations`);
          } else {
            // 处理失败
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

      const result = {
        total: data.length,
        created,
        skipped,
        skippedReasons,
        failed,
        stamps
      };

      // Complete the job
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'completed',
        progress: 100,
        message: `Completed processing ${data.length} orders`,
        result
      });
      
      // Set cleanup timeout for this job (e.g., 1 hour)
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

  // 处理订单及生成印章
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
    
    try {
      // 先查找可能的模板，获取描述信息用于LLM解析
      const sku = item['SKU']?.toString();
      let templateDescription: string | undefined;
      let templateFound = false;
      
      if (sku) {
        // 从 SKU 中提取基础部分（例如从 "AD-110-XX" 提取 "AD-110"）
        const skuBase = sku.split('-').slice(0, 2).join('-');
        
        // 尝试查找模板
        try {
          const templates = await this.orderStampService.findTemplatesBySku(sku, skuBase);
          if (templates && templates.length > 0) {
            // 获取模板描述信息，从textElements中收集
            const template = templates[0];
            templateFound = true;
            
            // 构建完整的模板描述，包括所有文本元素的信息
            const descriptionParts = [];
            // 从textElements中获取更详细的描述
            if (template.textElements && template.textElements.length > 0) {              
              template.textElements.forEach((element, index) => {
                const elementDesc = {
                  id: element.id,
                  description: element.description,
                  defaultValue: element.defaultValue
                }

                descriptionParts.push(elementDesc);
              });
            }
            
            templateDescription = JSON.stringify(descriptionParts);

            this.logger.log(`Found template description for SKU ${sku}: ${templateDescription}`);
          } else {
            this.logger.warn(`No template found for SKU ${sku}`);
            return {
              success: false,
              error: `No matching template found for SKU: ${sku}`
            };
          }
        } catch (error) {
          this.logger.warn(`Could not find template description for SKU ${sku}: ${error.message}`);
          return {
            success: false,
            error: `Error finding template for SKU ${sku}: ${error.message}`
          };
        }
      } else {
        this.logger.warn(`Order ${orderId} has no SKU, cannot find matching template`);
        return {
          success: false,
          error: 'Order has no SKU information, cannot find matching template'
        };
      }
      
      // 使用增强的parseVariations方法一次性处理所有信息
      const originalVariations = personalizationText || item['Variations'];
      
      if (!originalVariations) {
        return {
          success: false,
          error: 'No variations data found in order'
        };
      }
      
      // 使用增强的parseVariations方法解析variations和检测多个个性化信息
      const parsedResult = await this.parseVariations(originalVariations, templateDescription);
      
      // 创建临时订单ID
      const tempOrderId = uuidv4();
      
      // 创建共享的订单记录
      const stamps: Array<{ orderId: string; transactionId: string; stampPath: string }> = [];
      
      // 处理第一个个性化信息
      const mainItem = { ...item };
      // 保留原始的变量字符串
      mainItem['Variations'] = originalVariations;
      mainItem['ParsedVariations'] = parsedResult;
      
      // 创建基本订单
      const order = this.orderRepository.create({
        id: tempOrderId,
        status: 'stamp_not_generated',
        orderType: 'etsy',
        platformOrderId: orderId,
        platformOrderDate: item['Date Paid'] ? new Date(item['Date Paid']) : null,
        user: user,
        userId: user?.id,
        stampType: item['Stamp Type']?.toLowerCase() === 'steel' ? 'steel' : 'rubber' // 默认使用 rubber
      });
      
      // 创建临时EtsyOrder对象用于印章生成
      const tempEtsyOrder = {
        orderId,
        transactionId: baseTransactionId,
        order_id: order.id,
        sku: mainItem['SKU']?.toString(),
        variations: {
          ...parsedResult.variations,
          personalization: parsedResult.personalizations[0].reduce((acc, curr) => {
            acc[curr.id] = curr.value;
            return acc;
          }, {})
        },
        originalVariations: parsedResult.originalVariations
      };
      
      // 记录当前正在处理的个性化信息
      this.logger.log(`Processing personalization group #1: ${JSON.stringify(parsedResult.personalizations[0])}`);
      
      // 生成印章
      const stampResult = await this.orderStampService.generateStampFromOrder({
        order: tempEtsyOrder,
        convertTextToPaths: true
      });
      
      if (!stampResult.success) {
        this.logger.warn(`Failed to generate stamp for personalization group #1: ${stampResult.error}`);
        return {
          success: false,
          error: stampResult.error
        };
      }
      
      // 记录生成的印章记录ID
      if (stampResult.recordId) {
        stamps.push({
          orderId: order.id,
          transactionId: baseTransactionId,
          stampPath: stampResult.path.replace('uploads/', '/')
        });
      }
      
      // 如果成功生成了至少一个印章，则更新订单状态
      if (stamps.length > 0) {
        await this.orderRepository.update(
          { id: order.id },
          { status: 'stamp_generated_pending_review' }
        );
      }
      
      this.logger.log(`Generated ${stamps.length} stamps for order ${orderId}`);
      
      return {
        success: true,
        stamps
      };
    } catch (error) {
      this.logger.error(`Error processing order with stamp: ${error.message}`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Keep the original method for backward compatibility
  async parseExcelFile(file: Express.Multer.File): Promise<{
    total: number;
    created: number;
    skipped: number;
    skippedReasons: { orderId: string; transactionId: string; reason: string }[];
    failed: number;
    stamps: { orderId: string; transactionId: string; stampPath: string }[];
  }> {
    try {
      const workbook = read(file.buffer, { type: 'buffer' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = utils.sheet_to_json(worksheet);

      let created = 0;
      let skipped = 0;
      let failed = 0;
      const stamps: { orderId: string; transactionId: string; stampPath: string }[] = [];
      const skippedReasons: { orderId: string; transactionId: string; reason: string }[] = [];

      for (const item of data) {
        try {
          const orderId = item['Order ID']?.toString() || '';
          const transactionId = item['Transaction ID']?.toString() || '';
          
          if (!orderId) {
            skipped++;
            skippedReasons.push({ 
              orderId: 'Unknown', 
              transactionId: 'Unknown', 
              reason: 'Order ID is required' 
            });
            continue;
          }
          
          if (!transactionId) {
            skipped++;
            skippedReasons.push({ 
              orderId, 
              transactionId: 'Unknown', 
              reason: 'Transaction ID is required' 
            });
            continue;
          }

          // 检查是否存在相同的Transaction ID
          const existingOrder = await this.etsyOrderRepository.findOne({
            where: { transactionId }
          });

          if (existingOrder) {
            skipped++;
            skippedReasons.push({ 
              orderId, 
              transactionId, 
              reason: 'Order with this Transaction ID already exists' 
            });
            continue;
          }

          // 使用processOrderWithStamp处理订单，现在支持自动检测和处理多个个性化信息
          const orderResult = await this.processOrderWithStamp(item);
          
          if (orderResult.success && orderResult.stamps && orderResult.stamps.length > 0) {
            // 成功创建了订单和印章
            created += orderResult.stamps.length;
            
            // 将所有生成的印章添加到结果中
            stamps.push(...orderResult.stamps);
            
            this.logger.log(`Successfully processed order ${orderId} with ${orderResult.stamps.length} personalizations`);
          } else {
            // 处理失败
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

      return {
        total: data.length,
        created,
        skipped,
        skippedReasons,
        failed,
        stamps
      };
    } catch (error) {
      throw new Error(`Failed to parse Excel file: ${error.message}`);
    }
  }

  /**
   * 为导出的订单创建Excel文件
   * @param orders 订单列表
   * @param outputDir 输出目录
   * @returns 文件路径
   */
  async createOrdersExcelForExport(orders: Order[]): Promise<string> {
    try {
      const excelData = [];
      
      // Process each order to extract relevant information
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
      
      // Create workbook and worksheet
      const worksheet: WorkSheet = utils.json_to_sheet(excelData);
      const workbook: WorkBook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, '订单信息');
      
      // Make columns wider
      const colWidths = [
        { wch: 10 },  // 序号
        { wch: 20 },  // 订单号
        { wch: 15 },  // SKU
        { wch: 40 },  // 解析前的variants
        { wch: 40 },  // 解析后的variants
        { wch: 20 },  // 下单日期
        { wch: 15 },  // 文件名
      ];
      
      worksheet['!cols'] = colWidths;
      
      // Create output directory if it doesn't exist
      const exportDir = path.join(process.cwd(), 'uploads', 'exports');
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const excelFileName = `orders_info_${timestamp}.xlsx`;
      const excelFilePath = path.join(exportDir, excelFileName);
      
      // Write to file
      const excelBuffer = write(workbook, { bookType: 'xlsx', type: 'buffer' });
      fs.writeFileSync(excelFilePath, excelBuffer);
      
      this.logger.log(`Excel file created at: ${excelFilePath}`);
      
      return excelFilePath;
    } catch (error) {
      this.logger.error(`Failed to create Excel file: ${error.message}`, error.stack);
      throw new Error(`Failed to create Excel file: ${error.message}`);
    }
  }

  /**
   * 使用LLM解析订单变量和检测多个个性化信息
   * 一次性处理所有信息，包括：
   * 1. 解析变量为JSON格式
   * 2. 检测是否包含多个个性化信息
   * 3. 提取每个个性化信息段落并根据模板描述解析为结构化数据
   * @param variationsString 原始变量字符串
   * @param templateDescription 可选的模板描述，用于指导LLM解析
   * @returns 解析后的结果，包含变量对象和个性化信息数组
   */
  public async parseVariations(variationsString: string, templateDescription?: string): Promise<{
    variations: {
      [key: string]: string;
    };
    hasMultiple: boolean;
    personalizations: Array<Array<{
      id: string;
      value: string;
    }>>;
    originalVariations: string;
  }> {
    if (!variationsString) return {
      variations: null,
      hasMultiple: false,
      personalizations: [],
      originalVariations: ''
    };
    
    try {
      // 构建提示
      const prompt = `
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
      "1": {
        "id": "id_1",
        "value": "值1"
      },
      "2": {
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

      const userPrompt = 
`${templateDescription ? `
模版如下，请根据模版字段的描述 (description) 来理解和提取相关字段：
${templateDescription}
` : ''}

原始变量字符串:
${variationsString}`;

      // 调用GLM服务的generateJson方法
      try {
        const parsedResult = await this.aliyunService.generateJson(userPrompt, { systemPrompt: prompt });

        this.logger.log(`Parsed result: ${JSON.stringify(parsedResult)}`);

        return {
          ...parsedResult,
          originalVariations: variationsString
        };
      } catch (jsonError) {
        this.logger.warn(`Failed to parse variations using GLM JSON: ${jsonError.message}`);
      }
    } catch (error) {
      this.logger.error(`Error parsing variations using LLM: ${error.message}`, error);
      throw error;
    }
  }
} 