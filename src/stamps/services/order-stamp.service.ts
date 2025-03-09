import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';

import { StampsService } from '../stamps.service';
import { StampTemplate } from '../entities/stamp-template.entity';
import { GenerateStampDto } from '../dto/generate-stamp.dto';

@Injectable()
export class OrderStampService {
  private readonly logger = new Logger(OrderStampService.name);
  private readonly outputDir = 'uploads/stamps';

  constructor(
    private readonly stampsService: StampsService,
    @InjectRepository(StampTemplate)
    private stampTemplateRepository: Repository<StampTemplate>,
  ) {
    // 确保输出目录存在
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * 从 Etsy 订单生成印章
   */
  async generateStampFromOrder(order: any): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      // 检查是否有 SKU
      if (!order.sku) {
        return {
          success: false,
          error: 'Order has no SKU'
        };
      }

      // 从 SKU 中提取基础部分（例如从 "AD-110-XX" 提取 "AD-110"）
      const skuBase = order.sku.split('-').slice(0, 2).join('-');
      
      // 在数据库中查找匹配的模板
      const templates = await this.stampTemplateRepository.find({
        where: [
          { sku: order.sku },  // 精确匹配完整 SKU
          { sku: skuBase },    // 匹配基础 SKU
          { sku: Like(`${skuBase}%`) } // 模糊匹配以基础 SKU 开头的模板
        ],
        order: {
          // 优先使用精确匹配的模板
          sku: 'DESC'
        }
      });

      if (templates.length === 0) {
        return {
          success: false,
          error: `No template found for SKU ${order.sku}`
        };
      }

      // 使用找到的第一个模板
      const template = templates[0];
      this.logger.log(`Using template ${template.sku} for order with SKU ${order.sku}`);

      // 检查是否有 variations 数据
      if (!order.variations || !order.variations['Personalization']) {
        return {
          success: false,
          error: 'No personalization data found in order variations'
        };
      }

      // 解析个性化文本
      const personalization = order.variations['Personalization'];
      const lines = personalization.split('\n').map(line => line.trim()).filter(line => line);

      if (lines.length < 1) {
        return {
          success: false,
          error: 'Personalization text is empty or invalid'
        };
      }

      // 准备生成印章的数据
      const generateStampDto: GenerateStampDto = {
        templateId: template.id,
        textElements: []
      };

      // 根据模板中的文本元素数量和可用的个性化文本行数动态创建文本元素
      if (template.textElements && Array.isArray(template.textElements)) {
        template.textElements.forEach((element, index) => {
          if (element.id) {
            generateStampDto.textElements.push({
              id: element.id,
              value: index < lines.length ? lines[index] : ''
            });
          }
        });
      }

      // 生成印章
      const stampBuffer = await this.stampsService.generateStamp(generateStampDto);

      // 保存到文件
      const outputPath = path.join(this.outputDir, `${order.orderId}_${order.sku}.png`);
      fs.writeFileSync(outputPath, stampBuffer);

      return {
        success: true,
        path: outputPath
      };
    } catch (error) {
      this.logger.error(`Error generating stamp for order ${order.orderId}: ${error.message}`, error.stack);
      return {
        success: false,
        error: `Failed to generate stamp: ${error.message}`
      };
    }
  }
} 