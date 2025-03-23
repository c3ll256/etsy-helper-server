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
    failed: number;
    templateNotFound: number;
    stamps: { orderId: string; stampPath: string }[];
    skippedStamps: { orderId: string; reason: string }[];
  }> {
    try {
      const workbook = read(file.buffer, { type: 'buffer' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = utils.sheet_to_json(worksheet);

      let created = 0;
      let skipped = 0;
      let failed = 0;
      let templateNotFound = 0;
      const stamps: { orderId: string; stampPath: string }[] = [];
      const skippedStamps: { orderId: string; reason: string }[] = [];

      for (const item of data) {
        try {
          const orderId = item['Order ID']?.toString() || '';
          const sku = item['SKU']?.toString() || '';
          
          if (!orderId) {
            this.logger.warn('Skipping row without Order ID');
            skipped++;
            continue;
          }

          // 检查是否为重复订单 - 检查 orderId 和 sku
          const existingOrder = await this.etsyOrderRepository.findOne({
            where: { orderId }
          });

          // 如果找到相同订单ID，检查SKU是否也相同
          if (existingOrder) {
            // 如果SKU相同，跳过导入
            if (existingOrder.sku === sku) {
              this.logger.log(`Skipping duplicate order: ${orderId} with same SKU: ${sku}`);
              skipped++;
              continue;
            }
            // 如果SKU不同，继续导入流程
            this.logger.log(`Found order ${orderId} with different SKU (existing: ${existingOrder.sku}, new: ${sku}), continuing import`);
          }

          // 在导入订单前，先检查SKU是否有对应的模板
          const skuBase = sku.split('-').slice(0, 2).join('-');
          const hasTemplate = await this.orderStampService.hasTemplateForSku(sku, skuBase);
          
          if (!hasTemplate) {
            this.logger.warn(`No template found for SKU ${sku}, skipping order ${orderId}`);
            templateNotFound++;
            continue;
          }
          
          // 创建订单
          const result = await this.etsyOrderService.createFromExcelData(item);
          
          if (result.status === 'created') {
            created++;
            // 为新创建的订单生成图章
            try {
              // 使用模板系统生成印章
              const stampResult = await this.orderStampService.generateStampFromOrder({
                order: result.order,
                convertTextToPaths: true
              });
              
              // 如果成功生成印章
              if (stampResult.success && stampResult.path) {
                // 将文件路径转换为URL路径（去掉uploads前缀）
                const stampImageUrl = stampResult.path.replace('uploads/', '/');
                
                // 更新EtsyOrder记录
                await this.etsyOrderService.updateStampImage(
                  result.order.orderId,
                  stampImageUrl
                );

                // 更新Order状态为已生成印章待审核
                if (result.order.order) {
                  await this.orderRepository.update(
                    { id: result.order.order.id },
                    { status: 'stamp_generated_pending_review' }
                  );
                }

                stamps.push({
                  orderId: result.order.orderId,
                  stampPath: stampImageUrl
                });
                
                this.logger.log(`Generated stamp for order ${result.order.orderId} using template system`);
              } else {
                // 如果无法生成印章，记录错误
                this.logger.warn(`Failed to generate stamp for order ${result.order.orderId}: ${stampResult.error}`);
                skippedStamps.push({
                  orderId: result.order.orderId,
                  reason: stampResult.error
                });
              }
            } catch (stampError) {
              this.logger.error(`Error generating stamp for order ${result.order.orderId}:`, stampError);
              skippedStamps.push({
                orderId: result.order.orderId,
                reason: stampError.message
              });
            }
          } else {
            skipped++;
          }
        } catch (error) {
          this.logger.error(`Failed to process order:`, error);
          failed++;
        }
      }

      return {
        total: data.length,
        created,
        skipped,
        failed,
        templateNotFound,
        stamps,
        skippedStamps
      };
    } catch (error) {
      throw new Error(`Failed to parse Excel file: ${error.message}`);
    }
  }
} 