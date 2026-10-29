import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderMatchDetail } from '../entities/order.entity';
import { EtsyOrder } from '../entities/etsy-order.entity';
import { OrderStampService } from '../../stamps/services/order-stamp.service';
import { TemplateMatchService } from '../../stamps/services/template-match.service';
import { StampTemplate } from '../../stamps/entities/stamp-template.entity';
import { VariationParsingService } from './variation-parsing.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { RemoteAreaService } from 'src/common/services/remote-area.service';
import { OrderMatchStatus, OrderStatus, OrderType } from '../enums/order.enum';
import { User } from '../../users/entities/user.entity';
import * as dayjs from 'dayjs';
import * as customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(customParseFormat);

export class JobCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobCancelledError';
  }
}

@Injectable()
export class OrderProcessingService {
  private readonly logger = new Logger(OrderProcessingService.name);

  constructor(
    private readonly orderStampService: OrderStampService,
    private readonly jobQueueService: JobQueueService,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(EtsyOrder)
    private readonly etsyOrderRepository: Repository<EtsyOrder>,
    private readonly remoteAreaService: RemoteAreaService,
    private readonly templateMatchService: TemplateMatchService,
    private readonly variationParsingService: VariationParsingService,
  ) {}

  private normalizeOrderIdentityValue(value: unknown): string {
    return String(value ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
  }

  private getOriginalVariationsInput(item: any, personalizationText?: string): string {
    return this.normalizeOrderIdentityValue(personalizationText || item?.['Variations']);
  }

  private async findExistingImportedOrder(
    transactionId: string,
    sku: string,
    originalVariations: string,
  ): Promise<EtsyOrder | null> {
    return this.etsyOrderRepository.findOne({
      where: {
        transactionId,
        sku,
        originalVariations,
      },
      relations: ['order'],
    });
  }

  /**
   * 备注列：实际导出表里叫 "Note"。BUYER_NOTE_COLUMNS（逗号分隔）可追加列名，多列时按列名分段合并。
   * 原文照存，不 trim、不改换行（只统一 \r\n）。
   */
  getBuyerNoteColumns(): string[] {
    const configured = (process.env.BUYER_NOTE_COLUMNS || '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean);
    return Array.from(new Set([
      ...configured,
      'Note',
      'Buyer Note',
      'Buyer note',
      'buyer_note_raw',
      'Buyer Note Raw',
      'Message From Buyer',
      'Message from Buyer',
      'Notes to seller',
      'Note to seller',
      'Private Notes',
    ]));
  }

  extractBuyerNoteRaw(item: any): string | null {
    const parts: Array<{ key: string; value: string }> = [];
    for (const key of this.getBuyerNoteColumns()) {
      const value = item?.[key];
      if (value === undefined || value === null) continue;
      const text = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (!text.trim()) continue;
      parts.push({ key, value: text });
    }
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0].value;
    return parts.map(part => `【${part.key}】\n${part.value}`).join('\n\n');
  }

  /**
   * Validate order data from Excel
   */
  validateOrderData(item: any): {
    orderId: string;
    transactionId: string;
    validationError?: string;
  } {
    const orderId = item['Order ID']?.toString() || '';
    const transactionId = item['Transaction ID']?.toString() || '';
    
    if (!orderId) {
      return { orderId, transactionId, validationError: 'Order ID is required' };
    }
    
    if (!transactionId) {
      return { orderId, transactionId, validationError: 'Transaction ID is required' };
    }

    return { orderId, transactionId };
  }

  /**
   * 模板字段说明，交给 LLM 按字段 id 拆分个性化内容
   */
  buildTemplateDescription(template: StampTemplate): string {
    const descriptionParts = (template.textElements || []).map(element => ({
      id: element.id,
      description: element.description,
      defaultValue: element.defaultValue,
    }));

    const sections: string[] = [
      '字段定义(JSON 数组):',
      JSON.stringify(descriptionParts)
    ];
    if (template.description && template.description.trim().length > 0) {
      sections.push('补充说明:', template.description);
    }
    return sections.join('\n');
  }

  /**
   * Find template description for an order（按统一匹配规则，只在唯一匹配时返回）
   */
  async findTemplateDescription(item: any, user?: User): Promise<{
    templateDescription?: string;
    error?: string;
    templateId?: number;
  }> {
    const sku = item['SKU']?.toString();
    if (!sku) {
      return { error: 'Order has no SKU information, cannot find matching template' };
    }
    const match = await this.templateMatchService.match(sku, user);
    if (match.status !== OrderMatchStatus.EXACT || !match.template) {
      return { error: this.describeMatchProblem(match.status, match.detail) };
    }
    return {
      templateDescription: this.buildTemplateDescription(match.template),
      templateId: match.template.id,
    };
  }

  describeMatchProblem(status: OrderMatchStatus, detail?: OrderMatchDetail | null): string {
    if (status === OrderMatchStatus.CONFLICT) {
      const names = (detail?.candidates || []).map(c => `${c.templateName}(${c.matchedSku})`).join('、');
      const prefix = detail?.reason === 'multi_template' ? '多模板待选择' : '匹配冲突';
      return `${prefix}：SKU ${detail?.orderSku ?? ''} 符合多个模板 ${names}`;
    }
    return `未匹配到模板：SKU ${detail?.orderSku ?? ''}`;
  }

  /**
   * 解析变量并为订单生成印章。用于导入、重新匹配、手动换模板和重新处理。
   * 调用方负责覆盖确认和备份；这里会替换订单当前的印章列表。
   */
  async parseAndGenerateForOrder(
    order: Order,
    etsyOrder: EtsyOrder,
    template: StampTemplate,
    options: { jobId?: string; variationParsingService?: VariationParsingService } = {},
  ): Promise<{
    success: boolean;
    stamps: Array<{ orderId: string; transactionId: string; stampPath: string; recordId?: number }>;
    error?: string;
  }> {
    const parser = options.variationParsingService || this.variationParsingService;
    const originalVariations = etsyOrder.originalVariations || '';

    if (!originalVariations) {
      const error = 'No variations data found in order';
      await this.orderRepository.update({ id: order.id }, { processingError: error });
      return { success: false, stamps: [], error };
    }

    let parsedResult: any;
    try {
      parsedResult = await parser.parseVariations(originalVariations, this.buildTemplateDescription(template));
    } catch (error) {
      if (error instanceof JobCancelledError) throw error;
      const message = `变量解析失败：${error.message}`;
      await this.orderRepository.update({ id: order.id }, { processingError: message });
      return { success: false, stamps: [], error: message };
    }

    etsyOrder.variations = parsedResult.variations;
    etsyOrder.stampImageUrls = [];
    etsyOrder.stampGenerationRecordIds = [];
    await this.etsyOrderRepository.save(etsyOrder);

    const stamps: Array<{ orderId: string; transactionId: string; stampPath: string; recordId?: number }> = [];
    const failures: string[] = [];
    const personalizations = parsedResult.personalizations || [];

    for (let i = 0; i < personalizations.length; i++) {
      const personalizationGroup = personalizations[i];
      const tempEtsyOrder = {
        orderId: etsyOrder.orderId,
        transactionId: etsyOrder.transactionId,
        order_id: order.id,
        sku: etsyOrder.sku,
        variations: {
          ...parsedResult.variations,
          personalization: personalizationGroup.reduce((acc, curr) => {
            acc[curr.id] = curr.value;
            return acc;
          }, {})
        },
        originalVariations
      };

      this.logger.log(`Processing personalization group #${i + 1}: ${JSON.stringify(personalizationGroup)}`);

      const stampResult = await this.orderStampService.generateStampFromOrder({
        order: tempEtsyOrder,
        templateId: template.id,
        convertTextToPaths: true,
        jobId: options.jobId
      });

      if (stampResult.cancelled) {
        throw new JobCancelledError(stampResult.error || '任务已取消');
      }

      if (!stampResult.success) {
        this.logger.warn(`Failed to generate stamp for personalization group #${i + 1}: ${stampResult.error}`);
        failures.push(stampResult.error || '生成失败');
        continue;
      }

      if (stampResult.recordId) {
        const stampPath = stampResult.path.replace('uploads/', '/');
        stamps.push({
          orderId: etsyOrder.orderId,
          transactionId: etsyOrder.transactionId,
          stampPath,
          recordId: stampResult.recordId
        });
        etsyOrder.stampImageUrls = [...(etsyOrder.stampImageUrls || []), stampPath];
        etsyOrder.stampGenerationRecordIds = [...(etsyOrder.stampGenerationRecordIds || []), stampResult.recordId];
        await this.etsyOrderRepository.save(etsyOrder);
      }
    }

    const processingError = stamps.length === 0
      ? (failures[0] || 'No stamps were generated for any personalization group')
      : (failures.length > 0 ? `部分个性化生成失败：${failures.join('；')}` : null);

    await this.orderRepository.update(
      { id: order.id },
      {
        templateId: template.id,
        status: stamps.length > 0 ? OrderStatus.STAMP_GENERATED_PENDING_REVIEW : OrderStatus.STAMP_NOT_GENERATED,
        processingError,
        designAdjustedAt: null,
      }
    );

    this.logger.log(`Generated ${stamps.length} stamps for order ${etsyOrder.orderId}`);
    return { success: stamps.length > 0, stamps, error: stamps.length === 0 ? processingError : undefined };
  }

  /**
   * 重复导入时，未生成的旧订单删掉重建；已生成过的拒绝，避免覆盖已有设计（已导入订单请用重新匹配）
   */
  private async clearReimportableOrder(transactionId: string, sku: string, originalVariations: string): Promise<string | null> {
    const existing = await this.findExistingImportedOrder(transactionId, sku, originalVariations);
    if (!existing) return null;
    if (existing.order && existing.order.status !== OrderStatus.STAMP_NOT_GENERATED) {
      return 'Order with this Transaction ID already exists';
    }
    if (existing.stampGenerationRecordIds?.length > 0) {
      await this.orderStampService.deleteStampGenerationRecords(existing.stampGenerationRecordIds);
    }
    await this.etsyOrderRepository.remove(existing);
    if (existing.order) {
      await this.orderRepository.remove(existing.order);
    }
    this.logger.log(`Deleted existing order ${existing.orderId} with status STAMP_NOT_GENERATED for reimport`);
    return null;
  }

  /**
   * 导入一行订单：先按规则匹配模板。
   * 未匹配 / 冲突 / 解析失败也建订单，进入待处理清单（pending），不再静默跳过。
   */
  async processOrderWithStamp(
    item: any,
    user?: User,
    personalizationText?: string,
    jobId?: string,
    variationParsingService?: any,
    options: { source?: 'stamp' | 'rattle' } = {},
  ): Promise<{
    success: boolean;
    pending?: boolean;
    orderId?: string;
    stamps?: Array<{ orderId: string; transactionId: string; stampPath: string; recordId?: number }>;
    error?: string;
    cancelled?: boolean;
  }> {
    const orderId = item['Order ID']?.toString() || '';
    const baseTransactionId = item['Transaction ID']?.toString() || '';
    const sku = this.normalizeOrderIdentityValue(item['SKU']);
    const originalVariations = this.getOriginalVariationsInput(item, personalizationText);

    if (!orderId || !baseTransactionId) {
      return { success: false, error: 'Missing order ID or transaction ID' };
    }

    if (jobId && this.jobQueueService.isCancelRequested(jobId)) {
      throw new JobCancelledError('任务已取消，订单处理未开始');
    }

    const duplicateError = await this.clearReimportableOrder(baseTransactionId, sku, originalVariations);
    if (duplicateError) {
      return { success: false, error: duplicateError };
    }

    try {
      const match = await this.templateMatchService.match(sku, user);
      const template = match.status === OrderMatchStatus.EXACT ? match.template : undefined;

      const { order, etsyOrder } = await this.createOrderRecords(item, user, {
        templateId: template?.id ?? null,
        matchStatus: match.status,
        matchDetail: { ...match.detail, source: options.source || 'stamp' },
        originalVariations,
        processingError: template ? null : this.describeMatchProblem(match.status, match.detail),
      });

      if (!template) {
        return {
          success: false,
          pending: true,
          orderId: order.id,
          error: this.describeMatchProblem(match.status, match.detail),
        };
      }

      const result = await this.parseAndGenerateForOrder(order, etsyOrder, template, {
        jobId,
        variationParsingService,
      });

      return {
        success: result.success,
        pending: !result.success,
        orderId: order.id,
        stamps: result.stamps.length > 0 ? result.stamps : undefined,
        error: result.error,
      };
    } catch (error) {
      if (error instanceof JobCancelledError) {
        throw error;
      }
      this.logger.error(`Error processing order with stamp: ${error.message}`, error);
      return { success: false, error: error.message };
    }
  }

  private async createOrderRecords(
    item: any,
    user: User | undefined,
    init: {
      templateId: number | null;
      matchStatus: OrderMatchStatus;
      matchDetail: OrderMatchDetail;
      originalVariations: string;
      processingError: string | null;
    },
  ): Promise<{ order: Order; etsyOrder: EtsyOrder }> {
    const orderId = item['Order ID']?.toString() || '';
    const transactionId = item['Transaction ID']?.toString() || '';
    const sku = this.normalizeOrderIdentityValue(item['SKU']);
    const platformOrderDate = item['Date Paid'] ? this.parseDate(item['Date Paid']) : null;

    const order = this.orderRepository.create({
      status: OrderStatus.STAMP_NOT_GENERATED,
      orderType: OrderType.ETSY,
      platformOrderId: orderId,
      platformOrderDate,
      user,
      userId: user?.id,
      templateId: init.templateId,
      matchStatus: init.matchStatus,
      matchDetail: init.matchDetail,
      processingError: init.processingError,
      searchKey: this.generateSearchKey(item)
    });
    await this.orderRepository.save(order);

    // 并发导入保护：保存前再查一次
    const concurrent = await this.findExistingImportedOrder(transactionId, sku, init.originalVariations);
    if (concurrent && concurrent.order?.id !== order.id) {
      if (concurrent.order?.status !== OrderStatus.STAMP_NOT_GENERATED) {
        await this.orderRepository.remove(order);
        throw new Error('Order with this Transaction ID already exists (detected during creation)');
      }
      if (concurrent.stampGenerationRecordIds?.length > 0) {
        await this.orderStampService.deleteStampGenerationRecords(concurrent.stampGenerationRecordIds);
      }
      await this.etsyOrderRepository.remove(concurrent);
      if (concurrent.order) {
        await this.orderRepository.remove(concurrent.order);
      }
      this.logger.log(`Deleted concurrent duplicate order ${orderId} with status STAMP_NOT_GENERATED`);
    }

    const buyerNoteRaw = this.extractBuyerNoteRaw(item);
    const etsyOrder = this.etsyOrderRepository.create({
      orderId,
      transactionId,
      order,
      sku,
      variations: null,
      originalVariations: init.originalVariations,
      stampImageUrls: [],
      stampGenerationRecordIds: [],
      rawRow: item,
      buyerNoteRaw,
      buyerNoteSource: buyerNoteRaw ? 'import' : null,
      // Shipping information
      shipName: item['Ship Name']?.toString(),
      shipAddress1: item['Ship Address1']?.toString(),
      shipAddress2: item['Ship Address2']?.toString(),
      shipCity: item['Ship City']?.toString(),
      shipState: item['Ship State']?.toString(),
      isRemoteArea: this.remoteAreaService.isRemoteArea(item['Ship State']?.toString()),
      shipZipcode: item['Ship Zipcode']?.toString(),
      shipCountry: item['Ship Country']?.toString(),
      // Order details
      itemName: item['Item Name']?.toString(),
      listingId: item['Listing ID']?.toString(),
      buyer: item['Buyer']?.toString(),
      quantity: item['Quantity'] ? Number(item['Quantity']) : null,
      price: item['Price'] ? Number(item['Price']) : null,
      datePaid: item['Date Paid'] ? this.parseDate(item['Date Paid']) : null,
      saleDate: item['Sale Date'] ? this.parseDate(item['Sale Date']) : null,
      currency: item['Currency']?.toString(),
      couponCode: item['Coupon Code']?.toString(),
      couponDetails: item['Coupon Details']?.toString(),
      discountAmount: item['Discount Amount'] ? Number(item['Discount Amount']) : null,
      shippingDiscount: item['Shipping Discount'] ? Number(item['Shipping Discount']) : null,
      orderShipping: item['Order Shipping'] ? Number(item['Order Shipping']) : null,
      orderSalesTax: item['Order Sales Tax'] ? Number(item['Order Sales Tax']) : null,
      itemTotal: item['Item Total'] ? Number(item['Item Total']) : null,
      vatPaidByBuyer: item['VAT Paid by Buyer'] ? Number(item['VAT Paid by Buyer']) : null,
      orderType: item['Order Type']?.toString(),
      listingsType: item['Listings Type']?.toString(),
      paymentType: item['Payment Type']?.toString()
    });
    await this.etsyOrderRepository.save(etsyOrder);

    return { order, etsyOrder };
  }

  /**
   * Generate search key for order from shipping information
   */
  private generateSearchKey(item: any): string {
    const searchParts = [];
    
    // Add Buyer
    if (item['Buyer']) {
      searchParts.push(item['Buyer'].toString());
    }
    
    // Add shipping name/recipient
    if (item['Ship Name']) {
      searchParts.push(item['Ship Name'].toString());
    }
    
    return searchParts.filter(part => part.trim().length > 0).join(' ');
  }

  /**
   * Parse date string that might be in various formats including dd/mm/yyyy
   */
  private parseDate(input: any): Date | null {
    if (input === null || input === undefined) return null;

    try {
      // If it's already a Date
      if (input instanceof Date && !isNaN(input.getTime())) {
        return input;
      }

      // If it's an Excel serial number
      if (typeof input === 'number' && isFinite(input)) {
        // Excel (1900-based) serial number to JS Date
        const millis = Math.round((input - 25569) * 86400 * 1000);
        const d = new Date(millis);
        return isNaN(d.getTime()) ? null : d;
      }

      const dateStr = String(input).trim();
      if (!dateStr) return null;

      // Try dayjs strict with a broad set of patterns (US first per example 8/28/2025)
      const formats = [
        'M/D/YYYY', 'MM/DD/YYYY', 'M/D/YY', 'MM/DD/YY',
        'M/D/YYYY H:mm', 'MM/DD/YYYY H:mm', 'M/D/YYYY HH:mm', 'MM/DD/YYYY HH:mm',
        'M/D/YYYY h:mm A', 'MM/DD/YYYY h:mm A',
        'YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY-MM-DD HH:mm', 'YYYY/MM/DD HH:mm', 'YYYY-MM-DD HH:mm:ss', 'YYYY/MM/DD HH:mm:ss',
        'DD/MM/YYYY', 'DD-MM-YYYY'
      ];

      const parsed = dayjs(dateStr, formats, true);
      if (parsed.isValid()) {
        return parsed.toDate();
      }

      // Fallback to native Date
      const jsDate = new Date(dateStr);
      return isNaN(jsDate.getTime()) ? null : jsDate;
    } catch (error) {
      this.logger.warn(`Failed to parse date: ${input}`);
      return null;
    }
  }
}
