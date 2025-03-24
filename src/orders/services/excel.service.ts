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

  // 处理订单及生成印章，支持单个或多个个性化信息
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
      
      // 使用GLM服务解析variations
      const originalVariations = personalizationText || item['Variations'];
      
      if (!originalVariations) {
        return {
          success: false,
          error: 'No variations data found in order'
        };
      }
      
      // 使用LLM分析是否包含多个个性化信息
      const multiPersonalizationPrompt = `
请分析以下Etsy订单的变体信息，判断是否包含多个个性化信息（多个印章/地址等）。
如果包含多个个性化信息，请提取每个独立的个性化信息段落，并以JSON数组形式返回。

原始变体信息:
${originalVariations}

请按照以下格式返回JSON:
{
  "hasMultiple": true/false, // 是否包含多个个性化信息
  "personalizations": [      // 每个个性化信息段落
    "完整的第一个个性化信息", 
    "完整的第二个个性化信息",
    ...
  ]
}

如果只有一个个性化信息，返回的personalizations数组应只包含一项。
`;

      // 调用GLM服务分析
      const multiResult = await this.glmService.generateJson(multiPersonalizationPrompt, {
        temperature: 0.1
      });
      
      // 获取个性化信息列表
      const personalizations = multiResult && multiResult.personalizations ? 
        multiResult.personalizations : [originalVariations];
      
      // 处理检测到的多个个性化信息
      const stamps: Array<{ orderId: string; transactionId: string; stampPath: string }> = [];
      
      // 处理第一个个性化信息（主订单）
      const mainItem = { ...item };
      if (personalizations[0] !== originalVariations) {
        // 更新第一个个性化信息的变体字符串
        mainItem['Variations'] = personalizations[0];
      }
      
      // 创建临时的EtsyOrder对象用于模板匹配和图章生成
      const tempOrderId = uuidv4();
      const parsedVariations = await this.etsyOrderService.parseVariations(mainItem['Variations'], templateDescription);
      
      const tempEtsyOrder = {
        orderId,
        transactionId: baseTransactionId,
        order_id: tempOrderId,
        sku: mainItem['SKU']?.toString(),
        variations: parsedVariations,
        originalVariations: mainItem['Variations']
      };

      // 生成印章
      const stampResult = await this.orderStampService.generateStampFromOrder({
        order: tempEtsyOrder,
        convertTextToPaths: true
      });
      
      if (!stampResult.success) {
        return {
          success: false,
          error: stampResult.error || 'Failed to generate stamp'
        };
      }

      // 创建订单记录
      const orderResult = await this.etsyOrderService.createFromExcelData(mainItem, tempOrderId);
      
      if (orderResult.status !== 'created') {
        return {
          success: false,
          error: orderResult.reason || 'Unknown reason'
        };
      }
      
      // 将生成的印章与订单关联
      const stampImageUrl = stampResult.path.replace('uploads/', '/');
      
      // 更新EtsyOrder记录，使用transactionId查询确保更新正确的记录
      await this.etsyOrderService.updateStampImage(
        baseTransactionId,
        stampImageUrl
      );

      // 更新Order状态为已生成印章待审核
      if (orderResult.order.order) {
        await this.orderRepository.update(
          { id: orderResult.order.order.id },
          { status: 'stamp_generated_pending_review' }
        );
      }
      
      // 添加第一个印章到结果集
      stamps.push({
        orderId: orderResult.order.orderId,
        transactionId: orderResult.order.transactionId,
        stampPath: stampImageUrl
      });
      
      // 如果有多个个性化信息，处理额外的个性化信息
      if (personalizations.length > 1) {
        for (let i = 1; i < personalizations.length; i++) {
          // 为每个额外的个性化信息创建一个分割订单
          const additionalOrderId = uuidv4();
          const additionalTransactionId = `${baseTransactionId}-split-${i}`;
          
          // 创建带有更新个性化信息的对象
          const additionalItem = { ...item, '_tempOrderId': additionalOrderId };
          additionalItem['Variations'] = personalizations[i];
          
          // 创建临时的EtsyOrder对象用于模板匹配和图章生成
          const additionalVariations = await this.etsyOrderService.parseVariations(additionalItem['Variations'], templateDescription);
          
          const additionalTempEtsyOrder = {
            orderId,
            transactionId: additionalTransactionId,
            order_id: additionalOrderId,
            sku: additionalItem['SKU']?.toString(),
            variations: additionalVariations,
            originalVariations: additionalItem['Variations'],
            order: { id: additionalOrderId }
          };

          // 生成印章
          const additionalStampResult = await this.orderStampService.generateStampFromOrder({
            order: additionalTempEtsyOrder,
            convertTextToPaths: true
          });
          
          if (!additionalStampResult.success) {
            this.logger.warn(`Failed to generate stamp for additional order: ${additionalStampResult.error}`);
            continue;
          }

          // 创建额外订单记录
          const additionalOrderResult = await this.etsyOrderService.createAdditionalOrder(
            additionalItem,
            personalizations[i],
            i
          );
          
          if (additionalOrderResult.status !== 'created') {
            this.logger.warn(`Failed to create additional order: ${additionalOrderResult.reason}`);
            continue;
          }
          
          // 将生成的印章与额外订单关联
          const additionalStampImageUrl = additionalStampResult.path.replace('uploads/', '/');
          
          // 更新EtsyOrder记录
          await this.etsyOrderService.updateStampImage(
            additionalTransactionId,
            additionalStampImageUrl
          );

          // 更新Order状态为已生成印章待审核
          if (additionalOrderResult.order.order) {
            await this.orderRepository.update(
              { id: additionalOrderResult.order.order.id },
              { status: 'stamp_generated_pending_review' }
            );
          }
          
          // 添加额外印章到结果集
          stamps.push({
            orderId: additionalOrderResult.order.orderId,
            transactionId: additionalOrderResult.order.transactionId,
            stampPath: additionalStampImageUrl
          });
        }
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