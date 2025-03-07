import { Injectable } from '@nestjs/common';
import { read, utils } from 'xlsx';
import { EtsyOrderService } from './etsy-order.service';
import { StampGeneratorService } from './stamp-generator.service';

@Injectable()
export class ExcelService {
  constructor(
    private readonly etsyOrderService: EtsyOrderService,
    private readonly stampGeneratorService: StampGeneratorService,
  ) {}

  async parseExcelFile(file: Express.Multer.File): Promise<{
    total: number;
    created: number;
    skipped: number;
    failed: number;
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
      const stamps: { orderId: string; stampPath: string }[] = [];
      const skippedStamps: { orderId: string; reason: string }[] = [];

      for (const item of data) {
        try {
          const result = await this.etsyOrderService.createFromExcelData(item);
          if (result.status === 'created') {
            created++;
            // 为新创建的订单生成图章
            try {
              const stampResult = await this.stampGeneratorService.generateStamp(result.order);
              if (stampResult.success && stampResult.path) {
                // 将文件路径转换为URL路径（去掉uploads前缀）
                const stampImageUrl = stampResult.path.replace('uploads/', '/');
                
                // 更新EtsyOrder记录
                await this.etsyOrderService.updateStampImage(
                  result.order.orderId,
                  stampImageUrl
                );

                stamps.push({
                  orderId: result.order.orderId,
                  stampPath: stampImageUrl
                });
              } else {
                skippedStamps.push({
                  orderId: result.order.orderId,
                  reason: stampResult.error
                });
              }
            } catch (stampError) {
              console.error('Failed to generate stamp:', stampError);
              skippedStamps.push({
                orderId: result.order.orderId,
                reason: stampError.message
              });
            }
          } else {
            skipped++;
          }
        } catch (error) {
          console.error('Failed to process order:', error);
          failed++;
        }
      }

      return {
        total: data.length,
        created,
        skipped,
        failed,
        stamps,
        skippedStamps
      };
    } catch (error) {
      throw new Error(`Failed to parse Excel file: ${error.message}`);
    }
  }
} 