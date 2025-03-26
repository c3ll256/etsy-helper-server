import { Injectable, Logger } from '@nestjs/common';
import { read, utils, write, WorkSheet, WorkBook } from 'xlsx';
import { EtsyOrderService } from './etsy-order.service';
import { OrderStampService } from '../../stamps/services/order-stamp.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../entities/order.entity';
import { EtsyOrder } from '../entities/etsy-order.entity';
import { v4 as uuidv4 } from 'uuid';
import { JobQueueService } from './job-queue.service';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);

  constructor(
    private readonly etsyOrderService: EtsyOrderService,
    private readonly orderStampService: OrderStampService,
    private readonly jobQueueService: JobQueueService,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(EtsyOrder)
    private readonly etsyOrderRepository: Repository<EtsyOrder>,
  ) {}

  // New method for asynchronous processing with progress tracking
  async processExcelFileAsync(file: Express.Multer.File): Promise<string> {
    const jobId = this.jobQueueService.createJob();
    
    // Start processing in background
    this.processExcelFileWithProgress(file, jobId).catch(error => {
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
  private async processExcelFileWithProgress(file: Express.Multer.File, jobId: string): Promise<void> {
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
      const parsedResult = await this.etsyOrderService.parseVariations(originalVariations, templateDescription);
      
      // 创建临时订单ID
      const tempOrderId = uuidv4();
      
      // 创建共享的订单记录
      const stamps: Array<{ orderId: string; transactionId: string; stampPath: string }> = [];
      
      // 处理第一个个性化信息
      const mainItem = { ...item };
      // 保留原始的变量字符串
      mainItem['Variations'] = originalVariations;
      mainItem['ParsedVariations'] = parsedResult;
      
      // 创建基础订单
      const orderResult = await this.etsyOrderService.createFromExcelData(mainItem, tempOrderId);
      
      if (orderResult.status !== 'created') {
        return {
          success: false,
          error: orderResult.reason || 'Failed to create order'
        };
      }
      
      // 存储所有生成记录ID的数组
      const generatedRecordIds: number[] = [];
      
      // 处理每个个性化信息，为每个个性化信息生成单独的印章，但关联到同一个订单
      for (let i = 0; i < parsedResult.personalizations.length; i++) {
        // 准备个性化信息 - 现在是数组中的数组
        const currentPersonalizationGroup = parsedResult.personalizations[i];
        
        // 创建临时的EtsyOrder对象用于印章生成
        const tempEtsyOrder = {
          orderId,
          transactionId: baseTransactionId,
          order_id: orderResult.order?.order?.id || tempOrderId,
          sku: mainItem['SKU']?.toString(),
          variations: {
            ...parsedResult.variations,
            personalization: currentPersonalizationGroup.reduce((acc, curr) => {
              acc[curr.id] = curr.value;
              return acc;
            }, {})
          },
          originalVariations: parsedResult.originalVariations,
          order: { id: orderResult.order?.order?.id || tempOrderId }
        };
        
        // 记录当前正在处理的个性化信息
        this.logger.log(`Processing personalization group #${i+1}: ${JSON.stringify(currentPersonalizationGroup)}`);
        
        // 生成印章
        const stampResult = await this.orderStampService.generateStampFromOrder({
          order: tempEtsyOrder,
          convertTextToPaths: true
        });
        
        if (!stampResult.success) {
          this.logger.warn(`Failed to generate stamp for personalization group #${i + 1}: ${stampResult.error}`);
          continue; // 继续处理下一个个性化信息
        }
        
        // 记录生成的印章记录ID
        if (stampResult.recordId) {
          generatedRecordIds.push(stampResult.recordId);
        }
        
        // 将生成的印章与订单关联
        const stampImageUrl = stampResult.path.replace('uploads/', '/');
        
        // 加入印章结果集
        stamps.push({
          orderId: orderResult.order.orderId,
          transactionId: orderResult.order.transactionId,
          stampPath: stampImageUrl
        });
        
        // 更新EtsyOrder的stampImageUrl
        await this.etsyOrderService.updateStampImage(
          baseTransactionId,
          stampImageUrl,
          stampResult.recordId
        );
      }
      
      // 如果成功生成了至少一个印章，则更新订单状态
      if (stamps.length > 0 && orderResult.order?.order) {
        await this.orderRepository.update(
          { id: orderResult.order.order.id },
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
              '下单日期': order.etsyOrder.saleDate || order.createdAt,
              '文件名': `${i + 1}-${stampIndex + 1}${path.extname(stampUrl || '.svg')}`
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
} 