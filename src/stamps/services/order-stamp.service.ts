import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import * as fs from 'fs';

import { StampsService } from '../stamps.service';
import { PythonStampService } from './python-stamp.service';
import { StampTemplate } from '../entities/stamp-template.entity';
import { StampGenerationRecord } from '../entities/stamp-generation-record.entity';

@Injectable()
export class OrderStampService {
  private readonly logger = new Logger(OrderStampService.name);
  private readonly outputDir = 'uploads/stamps';

  constructor(
    private readonly stampsService: StampsService,
    private readonly pythonStampService: PythonStampService,
    @InjectRepository(StampTemplate)
    private stampTemplateRepository: Repository<StampTemplate>,
    @InjectRepository(StampGenerationRecord)
    private stampGenerationRecordRepository: Repository<StampGenerationRecord>,
  ) {
    // 确保输出目录存在
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * 从 Etsy 订单生成印章
   * @param order Etsy订单
   * @param customTextElements 可选的自定义文本元素，如果提供则使用这些元素而不是从personalization解析
   * @param customTemplateId 可选的自定义模板ID，如果提供则使用这个模板而不是从SKU查找
   * @param convertTextToPaths 是否将文本转换为路径，默认是 false
   */
  async generateStampFromOrder({order, customTextElements, customTemplateId, convertTextToPaths = false}: {
    order: any,
    customTextElements?: any[], 
    customTemplateId?: number,
    convertTextToPaths?: boolean
  }): Promise<{ 
    success: boolean; 
    path?: string; 
    error?: string; 
    templateId?: number;
    textElements?: any[];
    recordId?: number;
  }> {
    try {
      let template: any;
      let textElements: any[] = [];
      
      // 如果提供了自定义模板ID，则使用它
      if (customTemplateId) {
        try {
          template = await this.stampTemplateRepository.findOne({
            where: { id: customTemplateId }
          });
          
          if (!template) {
            return {
              success: false,
              error: `Template with ID ${customTemplateId} not found`
            };
          }
        } catch (error) {
          return {
            success: false,
            error: `Error finding template: ${error.message}`
          };
        }
      } else {
        // 否则从SKU查找模板
        // 检查是否有 SKU
        if (!order.sku) {
          return {
            success: false,
            error: '订单没有 SKU'
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
            error: `未能找到 SKU ${order.sku} 的模板`
          };
        }

        // 使用找到的第一个模板
        template = templates[0];
        this.logger.log(`使用模板 ${template.sku} 生成订单 ${order.orderId} 的印章`);
      }

      // 如果提供了自定义文本元素，则使用它们
      if (customTextElements && customTextElements.length > 0) {
        textElements = customTextElements;
      } else {
        // 否则从订单的个性化文本中解析
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

        // 根据模板中的文本元素数量和可用的个性化文本行数动态创建文本元素
        if (template.textElements && Array.isArray(template.textElements)) {
          textElements = template.textElements.map((element, index) => {
            if (element.id) {
              // 创建包含完整信息的文本元素
              return {
                id: element.id,
                value: index < lines.length ? lines[index] : '',
                fontFamily: element.fontFamily,
                fontSize: element.fontSize,
                fontWeight: element.fontWeight,
                fontStyle: element.fontStyle,
                color: element.color,
                position: { ...element.position } // 复制位置信息
              };
            }
          }).filter(Boolean);
        }
      }

      // 使用 Python 服务生成印章，而不是之前的 NestJS 方法
      const orderId = order.order?.id || order.orderId;
      const stampImageUrl = await this.pythonStampService.generateAndSaveStamp({
        template,
        textElements,
        orderId,
        convertTextToPaths
      });
      
      // 创建印章生成记录
      const record = this.stampGenerationRecordRepository.create({
        orderId: order.order_id,
        templateId: template.id,
        textElements: textElements,
        stampImageUrl: stampImageUrl
      });
      
      // 保存记录
      const savedRecord = await this.stampGenerationRecordRepository.save(record);

      return {
        success: true,
        path: stampImageUrl,
        templateId: template.id,
        textElements: textElements,
        recordId: savedRecord.id
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