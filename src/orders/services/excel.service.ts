import { Injectable } from '@nestjs/common';
import { read, utils } from 'xlsx';
import { EtsyOrderService } from './etsy-order.service';

@Injectable()
export class ExcelService {
  constructor(private readonly etsyOrderService: EtsyOrderService) {}

  async parseExcelFile(file: Express.Multer.File): Promise<{
    total: number;
    created: number;
    skipped: number;
    failed: number;
  }> {
    try {
      const workbook = read(file.buffer, { type: 'buffer' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = utils.sheet_to_json(worksheet);

      let created = 0;
      let skipped = 0;
      let failed = 0;

      for (const item of data) {
        try {
          const result = await this.etsyOrderService.createFromExcelData(item);
          if (result.status === 'created') {
            created++;
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
        failed
      };
    } catch (error) {
      throw new Error(`Failed to parse Excel file: ${error.message}`);
    }
  }
} 