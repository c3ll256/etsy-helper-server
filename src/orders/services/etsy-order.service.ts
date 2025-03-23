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

  async createFromExcelData(data: any): Promise<{ order: EtsyOrder | null; status: 'created' | 'skipped'; reason?: string }> {
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