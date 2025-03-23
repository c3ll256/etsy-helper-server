import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EtsyOrder } from '../entities/etsy-order.entity';
import { Order } from '../entities/order.entity';

@Injectable()
export class EtsyOrderService {
  private readonly logger = new Logger(EtsyOrderService.name);

  constructor(
    @InjectRepository(EtsyOrder)
    private etsyOrderRepository: Repository<EtsyOrder>,
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,
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
      variations: this.parseVariations(data['Variations']),
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

  // 检测并拆分多个个性化信息
  public detectMultiplePersonalizations(variationsString: string): { hasMultiple: boolean; personalizations: string[] } {
    if (!variationsString) {
      return { hasMultiple: false, personalizations: [] };
    }

    // 查找是否存在 "Personalization:" 或类似关键字
    if (!variationsString.includes('Personalization:')) {
      return { hasMultiple: false, personalizations: [] };
    }

    // 首先确认数据是否有多行内容
    const multiLineCheck = variationsString.split('\n').filter(line => line.trim().length > 0);
    if (multiLineCheck.length <= 1) {
      return { hasMultiple: false, personalizations: [] };
    }

    // 尝试识别多个地址模式
    try {
      // 解析包含多个个性化信息的字符串
      // 根据模式查找多个地址块
      const personalizationBlocks: string[] = [];
      let currentBlock = '';
      let inPersonalizationBlock = false;

      // 按行分割
      const lines = variationsString.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // 检测个性化开始：包含 "Personalization:" 的行
        if (line.includes('Personalization:')) {
          if (inPersonalizationBlock && currentBlock.trim()) {
            personalizationBlocks.push(currentBlock.trim());
          }
          inPersonalizationBlock = true;
          currentBlock = line;
        } 
        // 如果已在个性化信息块中，就继续添加行
        else if (inPersonalizationBlock) {
          currentBlock += '\n' + line;
          
          // 判断是否为新个性化信息的开始，通常是空行后跟着新的名字或地址
          const nextLine = i < lines.length - 1 ? lines[i + 1].trim() : '';
          if (line === '' && nextLine && !nextLine.includes('Personalization:') && 
              /^[A-Za-z]/.test(nextLine)) { // 简单判断是否为新名字的开始（以字母开头）
            personalizationBlocks.push(currentBlock.trim());
            inPersonalizationBlock = false;
            currentBlock = '';
          }
        }
      }
      
      // 添加最后一个块
      if (inPersonalizationBlock && currentBlock.trim()) {
        personalizationBlocks.push(currentBlock.trim());
      }

      // 如果解析出了多个地址块，则认为有多个个性化信息
      if (personalizationBlocks.length > 1) {
        return { hasMultiple: true, personalizations: personalizationBlocks };
      }
      
      // 如果上面的方法没有识别出多个块，尝试更简单的方法：查找是否存在多个完整地址格式
      // 例如通过查找是否存在多个州和邮编格式行
      const stateZipPattern = /[A-Z]{2}\s+\d{5}/g;
      const stateZipMatches = variationsString.match(stateZipPattern);
      
      if (stateZipMatches && stateZipMatches.length > 1) {
        // 如果找到多个州/邮编组合，则按照这些模式尝试拆分
        const blocks: string[] = [];
        let lastIndex = 0;
        
        for (let i = 0; i < stateZipMatches.length; i++) {
          const match = stateZipMatches[i];
          const matchIndex = variationsString.indexOf(match, lastIndex);
          const endOfLineIndex = variationsString.indexOf('\n', matchIndex);
          const blockEndIndex = endOfLineIndex > -1 ? endOfLineIndex : variationsString.length;
          
          // 找到这个州/邮编前面的文本作为一个块
          const blockStartIndex = i === 0 ? 0 : variationsString.lastIndexOf('\n', matchIndex);
          const blockText = variationsString.substring(blockStartIndex > -1 ? blockStartIndex : 0, blockEndIndex);
          
          blocks.push(blockText.trim());
          lastIndex = blockEndIndex;
        }
        
        // 如果找到多个块，返回它们
        if (blocks.length > 1) {
          return { hasMultiple: true, personalizations: blocks };
        }
      }
    } catch (error) {
      this.logger.error('Error detecting multiple personalizations:', error);
    }
    
    return { hasMultiple: false, personalizations: [] };
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
      variations: this.parseVariations(updatedVariations),
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

  public parseVariations(variationsString: string): any {
    if (!variationsString) return null;
    try {
      const variations = {};
      
      // 使用正则表达式匹配键值对，考虑冒号后可能出现的逗号
      const regex = /([^:,]+):([^,]+(?:,[^:,]+)*?)(?:,(?=[^,]+:)|$)/g;
      let match;
      
      while ((match = regex.exec(variationsString)) !== null) {
        const key = match[1]?.trim();
        const value = match[2]?.trim();
        
        if (key && value) {
          variations[key] = value;
        }
      }
      
      // 如果解析结果为空对象，尝试使用AI解析方法
      if (Object.keys(variations).length === 0) {
        return this.fallbackToAIParseVariations(variationsString);
      }
      
      return variations;
    } catch (error) {
      console.error('Error parsing variations:', error);
      return this.fallbackToAIParseVariations(variationsString);
    }
  }
  
  private fallbackToAIParseVariations(variationsString: string): any {
    // TODO: 实现AI解析方法
    console.log('Falling back to AI parsing for variations:', variationsString);
    // 暂时返回原始字符串作为单个值
    return { 'Raw Variations': variationsString };
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