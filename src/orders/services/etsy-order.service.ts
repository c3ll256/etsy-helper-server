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
      variations: await this.parseVariations(data['Variations']),
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

  // 生成额外的订单（针对多个个性化信息的情况）
  async createAdditionalOrder(
    originalOrderData: any, 
    personalizationText: string, 
    index: number
  ): Promise<{ order: EtsyOrder | null; status: 'created' | 'skipped'; reason?: string }> {
    const orderId = originalOrderData['Order ID']?.toString() || '';
    // 为额外订单生成唯一的transactionId，添加 -split-{index} 后缀
    const baseTransactionId = originalOrderData['Transaction ID']?.toString() || '';
    const transactionId = `${baseTransactionId}-split-${index}`;
    const tempOrderId = originalOrderData['_tempOrderId']; // Get the tempOrderId if it exists
    
    if (!orderId || !baseTransactionId) {
      return { 
        order: null, 
        status: 'skipped', 
        reason: 'Cannot create additional order without order ID or transaction ID' 
      };
    }

    // 检查是否已存在相同的分割订单
    const existingOrder = await this.etsyOrderRepository.findOne({
      where: { transactionId }
    });

    if (existingOrder) {
      return { 
        order: existingOrder, 
        status: 'skipped', 
        reason: 'Split order with this Transaction ID already exists' 
      };
    }

    // 创建新的基本订单
    const order = this.orderRepository.create({
      status: 'stamp_not_generated',
      orderType: 'etsy',
      platformOrderId: `${orderId}-split-${index}`,
      platformOrderDate: originalOrderData['Date Paid'] ? new Date(originalOrderData['Date Paid']) : null
    });

    // If a tempOrderId was provided, use it as the order id
    if (tempOrderId) {
      order.id = tempOrderId;
    }
    
    await this.orderRepository.save(order);

    // 准备一个新的变体字符串，保持原始的其他参数，但更新个性化信息
    let updatedVariations = originalOrderData['Variations'];
    if (updatedVariations && updatedVariations.includes('Personalization:')) {
      // 替换原始个性化信息
      const personalizationPattern = /Personalization:[^,]+(,|$)/;
      updatedVariations = updatedVariations.replace(
        personalizationPattern, 
        `Personalization:${personalizationText.replace(/\n/g, ' ')}$1`
      );
    }

    // 创建 Etsy 订单，拷贝原始订单的大部分信息，但修改变体和交易ID
    const etsyOrder = this.etsyOrderRepository.create({
      orderId,
      transactionId,
      listingId: originalOrderData['Listing ID']?.toString(),
      itemName: originalOrderData['Item Name'],
      buyer: originalOrderData['Buyer'],
      quantity: 1, // 分割后的订单数量始终为1
      price: originalOrderData['Price'],
      couponCode: originalOrderData['Coupon Code'],
      couponDetails: originalOrderData['Coupon Details'],
      discountAmount: originalOrderData['Discount Amount'],
      shippingDiscount: originalOrderData['Shipping Discount'],
      orderShipping: originalOrderData['Order Shipping'],
      orderSalesTax: originalOrderData['Order Sales Tax'],
      itemTotal: originalOrderData['Item Total'],
      currency: originalOrderData['Currency'],
      datePaid: originalOrderData['Date Paid'] ? new Date(originalOrderData['Date Paid']) : null,
      shipName: originalOrderData['Ship Name'],
      shipAddress1: originalOrderData['Ship Address1'],
      shipCity: originalOrderData['Ship City'],
      shipState: originalOrderData['Ship State'],
      shipZipcode: originalOrderData['Ship Zipcode']?.toString(),
      shipCountry: originalOrderData['Ship Country'],
      originalVariations: updatedVariations,
      variations: await this.parseVariations(updatedVariations),
      orderType: originalOrderData['Order Type'],
      listingsType: originalOrderData['Listings Type'],
      paymentType: originalOrderData['Payment Type'],
      vatPaidByBuyer: originalOrderData['VAT Paid by Buyer'],
      sku: originalOrderData['SKU'],
      saleDate: originalOrderData['Sale Date'] ? this.excelDateToJSDate(originalOrderData['Sale Date']) : null,
      order: order
    });

    const savedOrder = await this.etsyOrderRepository.save(etsyOrder);

    // 更新Order的searchKey字段
    const searchKeyParts = [
      orderId,
      originalOrderData['Buyer'],
      originalOrderData['Item Name'],
      originalOrderData['Ship Name'],
      originalOrderData['Ship Address1'],
      originalOrderData['Ship City'],
      originalOrderData['Ship State'],
      originalOrderData['Ship Zipcode'],
      originalOrderData['Ship Country'],
      originalOrderData['SKU'],
      updatedVariations,
      originalOrderData['Date Paid'] ? new Date(originalOrderData['Date Paid']).toISOString().split('T')[0] : null
    ];
    
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
   * 使用LLM解析订单变量
   * 替换原有的正则表达式解析方法，使用LLM进行更智能的解析
   * @param variationsString 原始变量字符串
   * @param templateDescription 可选的模板描述，用于指导LLM解析
   * @returns 解析后的变量对象
   */
  public async parseVariations(variationsString: string, templateDescription?: string): Promise<any> {
    if (!variationsString) return null;
    
    try {
      // 构建提示
      const prompt = `
你是一位解析Etsy订单变量的专家。你需要将原始的变量字符串解析为JSON格式。

${templateDescription ? `模板描述: ${templateDescription}

` : ''}原始变量字符串:
${variationsString}

请将上述变量解析为以下JSON格式，保留所有关键信息:
{
  "字段名1": "值1",
  "字段名2": "值2",
  ...
}

特别注意:
1. 个性化信息("Personalization")是最重要的字段，请确保完整保留
2. 忽略无关信息，只保留有意义的键值对
3. 保持原始文本的精确性，不要添加或删除内容
4. 仅输出JSON对象，不要有任何其他文本
`;

      // 调用GLM服务的generateJson方法
      try {
        const parsedResult = await this.glmService.generateJson(prompt, {
          temperature: 0.1 // 降低温度以获得更确定的结果
        });
        return parsedResult;
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
              return JSON.parse(jsonMatch[0]);
            } catch (parseError) {
              this.logger.warn(`Failed to parse extracted JSON: ${parseError.message}`);
            }
          }
        }
        
        // 回退方案2：将原始字符串作为单个值返回
        return { 'Raw Variations': variationsString };
      }
    } catch (error) {
      this.logger.error(`Error parsing variations using LLM: ${error.message}`, error);
      // 回退：将原始字符串作为单个值返回
      return { 'Raw Variations': variationsString };
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

  async updateStampImage(transactionId: string, stampImageUrl: string): Promise<void> {
    await this.etsyOrderRepository.update(
      { transactionId },
      { stampImageUrl }
    );
  }
} 