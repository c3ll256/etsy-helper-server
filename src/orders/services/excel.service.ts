import { Injectable, Logger } from '@nestjs/common';
import { read, utils } from 'xlsx';
import { EtsyOrderService } from './etsy-order.service';
import { OrderStampService } from '../../stamps/services/order-stamp.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../entities/order.entity';
import { EtsyOrder } from '../entities/etsy-order.entity';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);

  constructor(
    private readonly etsyOrderService: EtsyOrderService,
    private readonly orderStampService: OrderStampService,
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

          // 检查是否有多个个性化信息
          const variations = item['Variations']?.toString() || '';
          const multiplePersonalizations = this.etsyOrderService.detectMultiplePersonalizations(variations);

          // 处理多个个性化信息的情况（客户一次下单了多个不同的印章）
          if (multiplePersonalizations.hasMultiple && 
              multiplePersonalizations.personalizations.length > 0 &&
              parseInt(item['Quantity']?.toString() || '1') > 1) {
            
            this.logger.log(`Detected multiple personalizations (${multiplePersonalizations.personalizations.length}) for order ${orderId}`);
            
            // 处理第一个个性化信息（主订单）
            const mainOrderResult = await this.processOrderWithStamp(
              item, 
              multiplePersonalizations.personalizations[0]
            );
            
            if (mainOrderResult.success) {
              created++;
              stamps.push(mainOrderResult.stamp);
            } else {
              skipped++;
              skippedReasons.push({
                orderId,
                transactionId,
                reason: mainOrderResult.error || 'Failed to process main order'
              });
            }
            
            // 处理额外的个性化信息，从第二个开始
            for (let i = 1; i < multiplePersonalizations.personalizations.length; i++) {
              const additionalOrderResult = await this.processAdditionalOrder(
                item, 
                multiplePersonalizations.personalizations[i], 
                i
              );
              
              if (additionalOrderResult.success) {
                created++;
                stamps.push(additionalOrderResult.stamp);
              } else {
                skipped++;
                skippedReasons.push({
                  orderId: `${orderId}-split-${i}`,
                  transactionId: `${transactionId}-split-${i}`,
                  reason: additionalOrderResult.error || 'Failed to process additional order'
                });
              }
            }
          } 
          // 处理常规订单（只有一个个性化信息）
          else {
            // 使用现有的 processOrderWithStamp 方法处理常规订单
            const orderResult = await this.processOrderWithStamp(item);
            
            if (orderResult.success) {
              created++;
              stamps.push(orderResult.stamp);
            } else {
              skipped++;
              skippedReasons.push({
                orderId,
                transactionId,
                reason: orderResult.error || 'Failed to process order'
              });
            }
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

  // 处理主订单及生成印章
  private async processOrderWithStamp(
    item: any, 
    personalizationText?: string
  ): Promise<{
    success: boolean;
    stamp?: { orderId: string; transactionId: string; stampPath: string };
    error?: string;
  }> {
    const orderId = item['Order ID']?.toString() || '';
    const transactionId = item['Transaction ID']?.toString() || '';
    
    if (!orderId || !transactionId) {
      return {
        success: false,
        error: 'Missing order ID or transaction ID'
      };
    }
    
    try {
      // 如果提供了个性化文本，则创建更新后的变体
      let updatedItem = { ...item };
      if (personalizationText) {
        let updatedVariations = item['Variations'];
        if (updatedVariations && updatedVariations.includes('Personalization:')) {
          const personalizationPattern = /Personalization:[^,]+(,|$)/;
          updatedVariations = updatedVariations.replace(
            personalizationPattern, 
            `Personalization:${personalizationText.replace(/\n/g, ' ')}$1`
          );
          updatedItem['Variations'] = updatedVariations;
        }
      }
      
      // 创建临时的EtsyOrder对象用于模板匹配和图章生成
      const tempOrderId = uuidv4();
      const tempEtsyOrder = {
        orderId,
        transactionId,
        order_id: tempOrderId,
        sku: updatedItem['SKU']?.toString(),
        variations: this.etsyOrderService.parseVariations(updatedItem['Variations']),
        originalVariations: updatedItem['Variations']
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
      const orderResult = await this.etsyOrderService.createFromExcelData(updatedItem, tempOrderId);
      
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
        transactionId,
        stampImageUrl
      );

      // 更新Order状态为已生成印章待审核
      if (orderResult.order.order) {
        await this.orderRepository.update(
          { id: orderResult.order.order.id },
          { status: 'stamp_generated_pending_review' }
        );
      }
      
      this.logger.log(`Generated stamp for order ${orderResult.order.orderId} (Transaction ID: ${transactionId}) using template system`);

      return {
        success: true,
        stamp: {
          orderId: orderResult.order.orderId,
          transactionId: orderResult.order.transactionId,
          stampPath: stampImageUrl
        }
      };
    } catch (error) {
      this.logger.error(`Error processing order with stamp: ${error.message}`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 处理额外的订单及生成印章
  private async processAdditionalOrder(
    originalOrderData: any, 
    personalizationText: string, 
    index: number
  ): Promise<{
    success: boolean;
    stamp?: { orderId: string; transactionId: string; stampPath: string };
    error?: string;
  }> {
    const orderId = originalOrderData['Order ID']?.toString() || '';
    const baseTransactionId = originalOrderData['Transaction ID']?.toString() || '';
    const transactionId = `${baseTransactionId}-split-${index}`;
    
    if (!orderId || !baseTransactionId) {
      return {
        success: false,
        error: 'Missing order ID or transaction ID'
      };
    }
    
    try {
      // 准备有更新个性化信息的变体
      let updatedVariations = originalOrderData['Variations'];
      if (updatedVariations && updatedVariations.includes('Personalization:')) {
        const personalizationPattern = /Personalization:[^,]+(,|$)/;
        updatedVariations = updatedVariations.replace(
          personalizationPattern, 
          `Personalization:${personalizationText.replace(/\n/g, ' ')}$1`
        );
      }
      
      // 创建临时的EtsyOrder对象用于模板匹配和图章生成
      const tempOrderId = uuidv4();
      const tempEtsyOrder = {
        orderId,
        transactionId,
        order_id: tempOrderId,
        sku: originalOrderData['SKU']?.toString(),
        variations: this.etsyOrderService.parseVariations(updatedVariations),
        originalVariations: updatedVariations
      };

      // 先尝试生成印章
      const stampResult = await this.orderStampService.generateStampFromOrder({
        order: {
          ...tempEtsyOrder,
          order: { id: tempOrderId }
        },
        convertTextToPaths: true
      });
      
      if (!stampResult.success) {
        return {
          success: false,
          error: stampResult.error || 'Failed to generate stamp for additional order'
        };
      }

      // 创建额外订单记录
      const originalOrderDataWithId = Object.assign({}, originalOrderData, { '_tempOrderId': tempOrderId });
      const additionalOrderResult = await this.etsyOrderService.createAdditionalOrder(
        originalOrderDataWithId,
        personalizationText,
        index
      );
      
      if (additionalOrderResult.status !== 'created') {
        return {
          success: false,
          error: additionalOrderResult.reason || 'Failed to create additional order'
        };
      }
      
      // 将生成的印章与额外订单关联
      const stampImageUrl = stampResult.path.replace('uploads/', '/');
      
      // 更新EtsyOrder记录
      await this.etsyOrderService.updateStampImage(
        transactionId,
        stampImageUrl
      );

      // 更新Order状态为已生成印章待审核
      if (additionalOrderResult.order.order) {
        await this.orderRepository.update(
          { id: additionalOrderResult.order.order.id },
          { status: 'stamp_generated_pending_review' }
        );
      }

      return {
        success: true,
        stamp: {
          orderId: additionalOrderResult.order.orderId,
          transactionId: additionalOrderResult.order.transactionId,
          stampPath: stampImageUrl
        }
      };
    } catch (error) {
      this.logger.error(`Error processing additional order: ${error.message}`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
} 