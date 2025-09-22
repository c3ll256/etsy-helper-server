import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In } from 'typeorm';
import * as fs from 'fs';

import { PythonStampService } from './python-stamp.service';
import { StampTemplate, TextElement } from '../entities/stamp-template.entity';
import { StampGenerationRecord } from '../entities/stamp-generation-record.entity';

@Injectable()
export class OrderStampService {
  private readonly logger = new Logger(OrderStampService.name);
  private readonly outputDir = 'uploads/stamps';

  constructor(
    private readonly pythonStampService: PythonStampService,
    @InjectRepository(StampTemplate)
    private readonly stampTemplateRepository: Repository<StampTemplate>,
    @InjectRepository(StampGenerationRecord)
    private readonly stampGenerationRecordRepository: Repository<StampGenerationRecord>,
  ) {
    // 确保输出目录存在
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * 删除印章生成记录
   * @param recordIds 要删除的记录ID数组
   */
  async deleteStampGenerationRecords(recordIds: number[]): Promise<void> {
    if (recordIds?.length > 0) {
      await this.stampGenerationRecordRepository.delete(recordIds);
    }
  }

  /**
   * 根据SKU查找模板
   * @param sku 完整SKU
   * @param skuBase 基础SKU（可选）
   * @returns 匹配的模板数组
   */
  async findTemplatesBySku(sku: string, skuBase?: string): Promise<StampTemplate[]> {
    // 仅使用 skus 数组匹配
    const all = await this.stampTemplateRepository.find();
    const templates = all.filter(t => Array.isArray(t.skus) && t.skus.some(a => a && (a === sku || (skuBase && (a === skuBase || a.startsWith(skuBase))) || sku.includes(a))));

    // 维持原有排序原则：优先与订单 sku 更“具体”的匹配（数组内更具体/更长的优先）
    templates.sort((a, b) => {
      const aHasExact = a.skus?.includes(sku) ? 1 : 0;
      const bHasExact = b.skus?.includes(sku) ? 1 : 0;
      if (aHasExact !== bHasExact) return bHasExact - aHasExact;
      const aLongest = Math.max(...(a.skus || []).map(s => s?.length || 0), 0);
      const bLongest = Math.max(...(b.skus || []).map(s => s?.length || 0), 0);
      return bLongest - aLongest;
    });

    return templates;
  }

  /**
   * 从 Etsy 订单生成印章
   * @param order Etsy订单
   * @param customTextElements 可选的自定义文本元素，如果提供则使用这些元素而不是从personalization解析
   * @param customTemplateId 可选的自定义模板ID，如果提供则使用这个模板而不是从SKU查找
   * @param convertTextToPaths 是否将文本转换为路径，默认是 false
   */
  async generateStampFromOrder({order, customTextElements, templateId, convertTextToPaths = false}: {
    order: any,
    customTextElements?: TextElement[], 
    templateId?: number,
    convertTextToPaths?: boolean
  }): Promise<{ 
    success: boolean; 
    path?: string; 
    error?: string; 
    templateId?: number;
    textElements?: TextElement[];
    recordId?: number;
  }> {
    try {
      let template: any;
      let textElements: TextElement[] = [];
      
      // 如果提供了自定义模板ID，则使用它
      if (templateId) {
        try {
          template = await this.stampTemplateRepository.findOne({
            where: { id: templateId }
          });
          
          if (!template) {
            return {
              success: false,
              error: `Template with ID ${templateId} not found`
            };
          }
        } catch (error) {
          return {
            success: false,
            error: `Error finding template: ${error.message}`
          };
        }
      } else {
        // 没提供模板ID要报错
        return {
          success: false,
          error: 'No template ID provided'
        };
      }

      // 如果提供了自定义文本元素，则使用它们
      if (customTextElements && customTextElements.length > 0) {
        textElements = customTextElements;
      } else {
        // 否则从订单的个性化文本中解析
        // 检查是否有 variations 数据
        if (!order.variations) {
          return {
            success: false,
            error: 'No variations data found in order'
          };
        }
        
        // 获取个性化信息对象，现在通过LLM解析的结果存储在personalization字段中（小写）
        const personalizationObj = order.variations.personalization;
        
        if (!personalizationObj) {
          this.logger.warn(`No personalization object found in order variations: ${JSON.stringify(order.variations)}`);
          return {
            success: false,
            error: 'No personalization data found in order variations'
          };
        }

        this.logger.log(`Processing personalization object: ${JSON.stringify(personalizationObj)}`);

        // 根据模板中的文本元素和个性化信息对象创建文本元素
        if (template.textElements && Array.isArray(template.textElements)) {
          textElements = template.textElements.map((element: TextElement) => {
            if (!element.id) return null;
            
            // 直接使用textElement的id作为key查找personalizationObj中的值
            let value = '';
            
            // 如果个性化对象中有直接对应的key，使用它
            if (personalizationObj[element.id] !== undefined) {
              value = personalizationObj[element.id];
            }
            // 如果没有找到对应的key，尝试使用默认值
            else if (element.defaultValue) {
              value = element.defaultValue;
            }

            // 如果开启了自动大写，则将value转换为大写
            if (element.isUppercase) {
              value = value.toUpperCase();
            }
            
            // 创建包含完整信息的文本元素
            return {
              id: element.id,
              value,
              fontFamily: element.fontFamily,
              fontSize: element.fontSize,
              fontWeight: element.fontWeight,
              fontStyle: element.fontStyle,
              color: element.color,
              position: { ...element.position }, // 复制位置信息
              isUppercase: element.isUppercase,
              textPadding: element.textPadding,
              firstVariant: element.firstVariant,
              lastVariant: element.lastVariant,
              strokeWidth: element.strokeWidth,
              description: element.description,
            };
          }).filter(Boolean);
        }
      }

      // 使用 Python 服务生成印章
      const orderId = order.order?.id || order.order_id || order.orderId;
      const stampResult = await this.pythonStampService.generateAndSaveStamp({
        template,
        textElements,
        orderId,
        convertTextToPaths
      });
      
      // Process font size adjustments from Python if available
      if (stampResult.fontSizeAdjustments) {
        this.logger.log(`Received font size adjustments for ${Object.keys(stampResult.fontSizeAdjustments).length} elements`);
        
        // Apply font size adjustments to text elements
        textElements = textElements.map((element: TextElement) => {
          const elementId = element.id;
          if (elementId && stampResult.fontSizeAdjustments[elementId]) {
            const adjustment = stampResult.fontSizeAdjustments[elementId];
            
            // Update the fontSize with the adjusted value
            element.fontSize = adjustment.adjustedSize; // Simply replace the fontSize with the adjusted value
            
            this.logger.debug(`Adjusted font size for element ${elementId}: original=${adjustment.originalSize}, adjusted=${adjustment.adjustedSize}`);
          }
          return element;
        });
      }
      
      // 创建印章生成记录
      const record = this.stampGenerationRecordRepository.create({
        orderId: order.order_id || orderId,
        templateId: template.id,
        textElements: textElements,
        stampImageUrl: stampResult.path
      });
      
      // 保存记录
      const savedRecord = await this.stampGenerationRecordRepository.save(record);

      return {
        success: true,
        path: stampResult.path,
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