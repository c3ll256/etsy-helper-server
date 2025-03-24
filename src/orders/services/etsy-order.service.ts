import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EtsyOrder } from '../entities/etsy-order.entity';
import { Order } from '../entities/order.entity';
import { GlmService } from '../../common/services/glm.service';

@Injectable()
export class EtsyOrderService {
  private readonly logger = new Logger(EtsyOrderService.name);

  constructor(
    @InjectRepository(EtsyOrder)
    private etsyOrderRepository: Repository<EtsyOrder>,
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,
    private readonly glmService: GlmService,
  ) {}

  async createFromExcelData(data: any, tempOrderId: string | undefined): Promise<{ order: EtsyOrder | null; status: 'created' | 'skipped'; reason?: string }> {
    const orderId = data['Order ID']?.toString() || '';
    const transactionId = data['Transaction ID']?.toString() || '';
    
    if (!orderId) {
      throw new Error('Order ID is required');
    }
    
    if (!transactionId) {
      throw new Error('Transaction ID is required');
    }

    // 检查订单是否已存在，使用Transaction ID作为唯一判断标准
    const existingOrder = await this.etsyOrderRepository.findOne({
      where: { transactionId }
    });

    if (existingOrder) {
      return { order: existingOrder, status: 'skipped', reason: 'Order with this Transaction ID already exists' };
    }

    // 创建基本订单
    const order = this.orderRepository.create({
      id: tempOrderId,
      status: 'stamp_not_generated',
      orderType: 'etsy',
      platformOrderId: orderId,
      platformOrderDate: data['Date Paid'] ? new Date(data['Date Paid']) : null
    });
    
    await this.orderRepository.save(order);

    // 创建 Etsy 订单
    const etsyOrder = this.etsyOrderRepository.create({
      orderId,
      transactionId: data['Transaction ID']?.toString(),
      listingId: data['Listing ID']?.toString(),
      itemName: data['Item Name'],
      buyer: data['Buyer'],
      quantity: data['Quantity'],
      price: data['Price'],
      couponCode: data['Coupon Code'],
      couponDetails: data['Coupon Details'],
      discountAmount: data['Discount Amount'],
      shippingDiscount: data['Shipping Discount'],
      orderShipping: data['Order Shipping'],
      orderSalesTax: data['Order Sales Tax'],
      itemTotal: data['Item Total'],
      currency: data['Currency'],
      datePaid: data['Date Paid'] ? new Date(data['Date Paid']) : null,
      shipName: data['Ship Name'],
      shipAddress1: data['Ship Address1'],
      shipCity: data['Ship City'],
      shipState: data['Ship State'],
      shipZipcode: data['Ship Zipcode']?.toString(),
      shipCountry: data['Ship Country'],
      originalVariations: data['Variations'],
      variations: await this.parseVariations(data['Variations'], data['Template Description']),
      orderType: data['Order Type'],
      listingsType: data['Listings Type'],
      paymentType: data['Payment Type'],
      vatPaidByBuyer: data['VAT Paid by Buyer'],
      sku: data['SKU'],
      saleDate: data['Sale Date'] ? this.excelDateToJSDate(data['Sale Date']) : null,
      order: order
    });

    const savedOrder = await this.etsyOrderRepository.save(etsyOrder);

    // 更新Order的searchKey字段，用于模糊搜索
    const searchKeyParts = [
      orderId,
      data['Buyer'],
      data['Item Name'],
      data['Ship Name'],
      data['Ship Address1'],
      data['Ship City'],
      data['Ship State'],
      data['Ship Zipcode'],
      data['Ship Country'],
      data['SKU'],
      data['Variations'],
      data['Date Paid'] ? new Date(data['Date Paid']).toISOString().split('T')[0] : null
    ];
    
    // 过滤掉空值并连接
    const searchKey = searchKeyParts
      .filter(part => part)
      .join(' ')
      .trim();
    
    if (searchKey) {
      await this.orderRepository.update(
        { id: order.id },
        { searchKey }
      );
    }

    return { order: savedOrder, status: 'created' };
  }

  /**
   * 使用LLM解析订单变量和检测多个个性化信息
   * 一次性处理所有信息，包括：
   * 1. 解析变量为JSON格式
   * 2. 检测是否包含多个个性化信息
   * 3. 提取每个个性化信息段落并根据模板描述解析为结构化数据
   * @param variationsString 原始变量字符串
   * @param templateDescription 可选的模板描述，用于指导LLM解析
   * @returns 解析后的结果，包含变量对象和个性化信息数组
   */
  public async parseVariations(variationsString: string, templateDescription?: string): Promise<{
    variations: any;
    hasMultiple: boolean;
    personalizations: Array<{
      [key: string]: string;
    }>;
    originalVariations: string; // 保存原始的变量字符串
  }> {
    if (!variationsString) return {
      variations: null,
      hasMultiple: false,
      personalizations: [],
      originalVariations: ''
    };
    
    try {
      // 构建提示
      const prompt = `
你是一位解析Etsy订单变量的专家。你需要完成两个任务：
1. 将原始的变量字符串解析为JSON格式
2. 分析是否包含多个个性化信息（多个印章/地址等），并将每个个性化信息根据模板描述解析为结构化数据

${templateDescription ? `
模板描述如下，请根据这个描述来理解和提取相关字段：
${templateDescription}

` : ''}原始变量字符串:
${variationsString}

请按照以下格式返回JSON:
{
  "variations": {
    "字段名1": "值1",
    "字段名2": "值2",
    ...
  },
  "hasMultiple": true/false, // 是否包含多个个性化信息
  "personalizations": [      // 每个个性化信息段落的结构化数据
    {
      "字段1": "值1",
      "字段2": "值2",
      ...
    },
    {
      "字段1": "值1",
      "字段2": "值2",
      ...
    }
  ]
}

特别注意:
1. 个性化信息("Personalization")是最重要的字段，请确保完整保留
2. 如果只有一个个性化信息，hasMultiple 应为 false，personalizations 数组应只包含一项
3. 保持原始文本的精确性，不要添加或删除内容
4. 仅输出JSON对象，不要有任何其他文本
5. 每个个性化信息都应该根据模板描述被解析为结构化的对象，包含所有相关字段
`;

      // 调用GLM服务的generateJson方法
      try {
        const parsedResult = await this.glmService.generateJson(prompt, {
          temperature: 0.1 // 降低温度以获得更确定的结果
        });
        return {
          ...parsedResult,
          originalVariations: variationsString // 添加原始变量字符串
        };
      } catch (jsonError) {
        this.logger.warn(`Failed to parse variations using GLM JSON: ${jsonError.message}`);
        // 回退方案1：尝试使用generateText
        const response = await this.glmService.generateText(prompt);
        if (response && response.choices && response.choices[0] && response.choices[0].message) {
          const content = response.choices[0].message.content;
          // 尝试提取JSON部分
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              return {
                ...parsed,
                originalVariations: variationsString
              };
            } catch (parseError) {
              this.logger.warn(`Failed to parse extracted JSON: ${parseError.message}`);
            }
          }
        }
        
        // 回退方案2：将原始字符串作为单个值返回
        return {
          variations: { 'Raw Variations': variationsString },
          hasMultiple: false,
          personalizations: [{ 'Raw Personalization': variationsString }],
          originalVariations: variationsString
        };
      }
    } catch (error) {
      this.logger.error(`Error parsing variations using LLM: ${error.message}`, error);
      // 回退：将原始字符串作为单个值返回
      return {
        variations: { 'Raw Variations': variationsString },
        hasMultiple: false,
        personalizations: [{ 'Raw Personalization': variationsString }],
        originalVariations: variationsString
      };
    }
  }

  private excelDateToJSDate(excelDate: number): Date | null {
    try {
      const millisecondsPerDay = 24 * 60 * 60 * 1000;
      const excelEpoch = new Date(1900, 0, 1);
      const daysSinceExcelEpoch = excelDate - 1;
      const millisecondsSinceExcelEpoch = daysSinceExcelEpoch * millisecondsPerDay;
      return new Date(excelEpoch.getTime() + millisecondsSinceExcelEpoch);
    } catch (error) {
      console.error('Error converting Excel date:', error);
      return null;
    }
  }

  /**
   * 更新Etsy订单的印章图片URL
   * @param transactionId 交易ID
   * @param stampImageUrl 印章图片URL
   * @param recordId 可选，stamp生成记录ID，如果提供则添加到记录ID数组
   */
  async updateStampImage(
    transactionId: string, 
    stampImageUrl: string,
    recordId?: number
  ): Promise<void> {
    // 查找匹配的订单
    const order = await this.etsyOrderRepository.findOne({
      where: { transactionId }
    });
    
    if (!order) {
      throw new Error(`Order with transaction ID ${transactionId} not found`);
    }
    
    // 更新图片URL
    order.stampImageUrl = stampImageUrl;
    
    // 如果提供了记录ID，添加到数组中
    if (recordId) {
      if (!order.stampGenerationRecordIds) {
        order.stampGenerationRecordIds = [];
      }
      
      // 确保不重复添加
      if (!order.stampGenerationRecordIds.includes(recordId)) {
        order.stampGenerationRecordIds.push(recordId);
      }
    }
    
    // 保存更新
    await this.etsyOrderRepository.save(order);
  }
} 