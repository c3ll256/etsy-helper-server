import { Injectable, Logger } from '@nestjs/common';
import { read, utils } from 'xlsx';
import { EtsyOrderService } from './etsy-order.service';
import { OrderStampService } from '../../stamps/services/order-stamp.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../entities/order.entity';
import { EtsyOrder } from '../entities/etsy-order.entity';

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
    skippedReasons: { orderId: string; reason: string }[];
    failed: number;
    stamps: { orderId: string; stampPath: string }[];
  }> {
    try {
      const workbook = read(file.buffer, { type: 'buffer' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = utils.sheet_to_json(worksheet);

      let created = 0;
      let skipped = 0;
      let failed = 0;
      const stamps: { orderId: string; stampPath: string }[] = [];
      const skippedReasons: { orderId: string; reason: string }[] = [];

      for (const item of data) {
        try {
          const orderId = item['Order ID']?.toString() || '';
          
          // 创建临时的EtsyOrder对象用于模板匹配和图章生成
          const tempEtsyOrder = {
            orderId,
            transactionId: item['Transaction ID']?.toString(),
            sku: item['SKU']?.toString(),
            variations: this.etsyOrderService.parseVariations(item['Variations']),
            originalVariations: item['Variations']
          };

          // 先尝试生成印章，确认有对应的模板
          try {
            const stampResult = await this.orderStampService.generateStampFromOrder({
              order: tempEtsyOrder,
              convertTextToPaths: true
            });
            
            // 如果无法生成印章，则跳过该订单
            if (!stampResult.success) {
              skipped++;
              skippedReasons.push({
                orderId,
                reason: stampResult.error || 'Failed to generate stamp'
              });
              continue;
            }

            // 印章生成成功，创建订单记录
            // createFromExcelData 内部会处理所有验证逻辑，比如检查重复订单等
            const orderResult = await this.etsyOrderService.createFromExcelData(item);
            
            if (orderResult.status === 'created') {
              created++;
              
              // 将生成的印章与订单关联
              const stampImageUrl = stampResult.path.replace('uploads/', '/');
              
              // 更新EtsyOrder记录
              await this.etsyOrderService.updateStampImage(
                orderResult.order.orderId,
                stampImageUrl
              );

              // 更新Order状态为已生成印章待审核
              if (orderResult.order.order) {
                await this.orderRepository.update(
                  { id: orderResult.order.order.id },
                  { status: 'stamp_generated_pending_review' }
                );
              }

              stamps.push({
                orderId: orderResult.order.orderId,
                stampPath: stampImageUrl
              });
              
              this.logger.log(`Generated stamp for order ${orderResult.order.orderId} using template system`);
            } else {
              // 创建订单过程中出现问题，记录原因
              skipped++;
              skippedReasons.push({
                orderId,
                reason: orderResult.reason || 'Unknown reason'
              });
            }
          } catch (stampError) {
            this.logger.error(`Error generating stamp for order ${orderId}:`, stampError);
            skipped++;
            skippedReasons.push({
              orderId,
              reason: stampError.message
            });
          }
        } catch (error) {
          this.logger.error(`Failed to process order:`, error);
          failed++;
          const orderId = item['Order ID']?.toString() || 'Unknown';
          skippedReasons.push({
            orderId,
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
} 