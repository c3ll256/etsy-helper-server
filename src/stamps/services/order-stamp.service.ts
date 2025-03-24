import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import * as fs from 'fs';

import { PythonStampService } from './python-stamp.service';
import { StampTemplate } from '../entities/stamp-template.entity';
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
   * 根据SKU查找模板
   * @param sku 完整SKU
   * @param skuBase 基础SKU（可选）
   * @returns 匹配的模板数组
   */
  async findTemplatesBySku(sku: string, skuBase?: string): Promise<StampTemplate[]> {
    const whereConditions = [];
    
    // 精确匹配完整SKU
    whereConditions.push({ sku: sku });
    
    // 如果提供了基础SKU，也尝试匹配它
    if (skuBase) {
      whereConditions.push({ sku: skuBase });
      whereConditions.push({ sku: Like(`${skuBase}%`) });
    }
    
    // 查找匹配的模板
    const templates = await this.stampTemplateRepository.find({
      where: whereConditions,
      order: {
        // 优先使用精确匹配的模板
        sku: 'DESC'
      }
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
        
        // 查找匹配的模板
        const templates = await this.findTemplatesBySku(order.sku, skuBase);

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
          textElements = template.textElements.map(element => {
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
            
            // 创建包含完整信息的文本元素
            return {
              id: element.id,
              value,
              fontFamily: element.fontFamily,
              fontSize: element.fontSize,
              fontWeight: element.fontWeight,
              fontStyle: element.fontStyle,
              color: element.color,
              position: { ...element.position } // 复制位置信息
            };
          }).filter(Boolean);
        }
      }

      // 使用 Python 服务生成印章
      const orderId = order.order?.id || order.order_id || order.orderId;
      const stampImageUrl = await this.pythonStampService.generateAndSaveStamp({
        template,
        textElements,
        orderId,
        convertTextToPaths
      });
      
      // 创建印章生成记录
      const record = this.stampGenerationRecordRepository.create({
        orderId: order.order_id || orderId,
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