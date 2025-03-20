import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';

import { StampsService } from '../stamps.service';
import { StampTemplate } from '../entities/stamp-template.entity';
import { StampGenerationRecord } from '../entities/stamp-generation-record.entity';
import { GenerateStampDto } from '../dto/generate-stamp.dto';

@Injectable()
export class OrderStampService {
  private readonly logger = new Logger(OrderStampService.name);
  private readonly outputDir = 'uploads/stamps';

  constructor(
    private readonly stampsService: StampsService,
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
   */
  async generateStampFromOrder(
    order: any, 
    customTextElements?: any[], 
    customTemplateId?: number
  ): Promise<{ 
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

      // 准备生成印章的数据
      const generateStampDto: GenerateStampDto = {
        templateId: template.id,
        textElements: textElements
      };

      // 生成印章
      const stampBuffer = await this.stampsService.generateStamp(generateStampDto);

      // 生成文件名
      const timestamp = Date.now();
      const fileName = `${order.orderId}_${timestamp}.png`;
      const outputPath = path.join(this.outputDir, fileName);
      
      // 保存到文件
      fs.writeFileSync(outputPath, stampBuffer);
      
      // 转换为URL路径（用于存储和返回）
      const stampImageUrl = `/stamps/${fileName}`;
      
      // 创建印章生成记录的完整数据
      // 确保保存完整的文本元素信息
      const recordTextElements = textElements.map(el => {
        // 如果是自定义文本元素，可能需要补充模板中的默认值
        const templateEl = template.textElements.find(t => t.id === el.id);
        return {
          id: el.id,
          value: el.value,
          fontFamily: el.fontFamily || templateEl?.fontFamily,
          fontSize: el.fontSize || templateEl?.fontSize,
          fontWeight: el.fontWeight || templateEl?.fontWeight,
          fontStyle: el.fontStyle || templateEl?.fontStyle,
          color: el.color || templateEl?.color,
          position: {
            x: el.position?.x || templateEl?.position?.x,
            y: el.position?.y || templateEl?.position?.y,
            width: el.position?.width || templateEl?.position?.width,
            height: el.position?.height || templateEl?.position?.height,
            rotation: el.position?.rotation || templateEl?.position?.rotation,
            textAlign: el.position?.textAlign || templateEl?.position?.textAlign
          }
        };
      });
      
      // 创建印章生成记录
      const record = await this.stampGenerationRecordRepository.create({
        orderId: order.order?.id || order.orderId,
        templateId: template.id,
        textElements: recordTextElements,
        stampImageUrl: stampImageUrl,
        format: 'png'
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