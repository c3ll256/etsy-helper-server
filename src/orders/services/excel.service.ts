import { Injectable, Logger } from '@nestjs/common';
import { read, utils } from 'xlsx';
import { EtsyOrderService } from './etsy-order.service';
import { OrderStampService } from '../../stamps/services/order-stamp.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../entities/order.entity';
import { EtsyOrder } from '../entities/etsy-order.entity';
import { v4 as uuidv4 } from 'uuid';
import { GlmService } from '../../common/services/glm.service';

@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);

  constructor(
    private readonly etsyOrderService: EtsyOrderService,
    private readonly orderStampService: OrderStampService,
    private readonly glmService: GlmService,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(EtsyOrder)
    private readonly etsyOrderRepository: Repository<EtsyOrder>,
  ) {}

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
      
      if (sku) {
        // 从 SKU 中提取基础部分（例如从 "AD-110-XX" 提取 "AD-110"）
        const skuBase = sku.split('-').slice(0, 2).join('-');
        
        // 尝试查找模板
        try {
          const templates = await this.orderStampService.findTemplatesBySku(sku, skuBase);
          if (templates && templates.length > 0) {
            templateDescription = templates[0].description;
          }
        } catch (error) {
          this.logger.warn(`Could not find template description for SKU ${sku}: ${error.message}`);
        }
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
        // 准备个性化信息
        const currentPersonalization = parsedResult.personalizations[i];
        const variationsWithPersonalization = {
          ...parsedResult.variations,
          ...currentPersonalization // 直接展开个性化信息对象
        };
        
        // 创建临时的EtsyOrder对象用于印章生成
        const tempEtsyOrder = {
          orderId,
          transactionId: baseTransactionId,
          order_id: orderResult.order?.order?.id || tempOrderId,
          sku: mainItem['SKU']?.toString(),
          variations: variationsWithPersonalization,
          originalVariations: parsedResult.originalVariations, // 使用原始未处理的变量字符串
          order: { id: orderResult.order?.order?.id || tempOrderId }
        };
        
        // 生成印章
        const stampResult = await this.orderStampService.generateStampFromOrder({
          order: tempEtsyOrder,
          convertTextToPaths: true
        });
        
        if (!stampResult.success) {
          this.logger.warn(`Failed to generate stamp for personalization #${i + 1}: ${stampResult.error}`);
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
        
        // 如果是第一个印章，更新EtsyOrder的stampImageUrl
        if (i === 0) {
          // 更新EtsyOrder记录，使用transactionId查询确保更新正确的记录
          await this.etsyOrderService.updateStampImage(
            baseTransactionId,
            stampImageUrl,
            stampResult.recordId
          );
        } else {
          // 对于后续的印章，只添加记录ID，不更新URL
          if (stampResult.recordId) {
            await this.etsyOrderService.updateStampImage(
              baseTransactionId,
              orderResult.order.stampImageUrl || stampImageUrl,
              stampResult.recordId
            );
          }
        }
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
} 