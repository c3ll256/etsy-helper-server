import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../entities/order.entity';
import { EtsyOrder } from '../entities/etsy-order.entity';
import { OrderStampService } from '../../stamps/services/order-stamp.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { RemoteAreaService } from 'src/common/services/remote-area.service';
import { OrderStatus, OrderType } from '../enums/order.enum';
import { User } from '../../users/entities/user.entity';
import * as dayjs from 'dayjs';
import * as customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(customParseFormat);

class JobCancelledError extends Error {
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
  ) {}

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
   * Find template description for an order
   */
  async findTemplateDescription(item: any): Promise<{
    templateDescription?: string;
    error?: string;
    templateId?: number;
  }> {
    const sku = item['SKU']?.toString();
    const orderId = item['Order ID']?.toString() || '';
    
    if (!sku) {
      this.logger.warn(`Order ${orderId} has no SKU, cannot find matching template`);
      return { error: 'Order has no SKU information, cannot find matching template' };
    }
    
    try {
      const templates = await this.orderStampService.findTemplatesBySku(sku);
      
      if (!templates || templates.length === 0) {
        this.logger.warn(`No template found for SKU ${sku}`);
        return { error: `No matching template found for SKU: ${sku}` };
      }
      
      const normalizeSkuValue = (value: string): string => (value || '').toLowerCase().trim();
      const tokenizeSkuValue = (value: string): string[] =>
        normalizeSkuValue(value)
          .split(/(?:\s+|-)+/)
          .filter(token => token.length > 0);
      const normalizedSku = normalizeSkuValue(sku);
      const orderTokens = tokenizeSkuValue(sku);
      const orderTokenSet = new Set(orderTokens);

      type MatchCandidate = {
        template: any;
        alias?: string;
        coverage: number;
        sharedTokenCount: number;
      };

      let bestMatch: MatchCandidate | undefined;

      for (const template of templates) {
        if (!Array.isArray(template.skus) || template.skus.length === 0) {
          continue;
        }

        for (const aliasRaw of template.skus) {
          if (!aliasRaw || typeof aliasRaw !== 'string') {
            continue;
          }

          const normalizedAlias = normalizeSkuValue(aliasRaw);
          if (!normalizedAlias) continue;

          if (normalizedAlias === normalizedSku) {
            bestMatch = {
              template,
              alias: aliasRaw,
              coverage: 1,
              sharedTokenCount: tokenizeSkuValue(aliasRaw).length
            };
            break;
          }

          const aliasTokens = tokenizeSkuValue(aliasRaw);
          if (aliasTokens.length === 0) {
            continue;
          }

          const sharedTokens = aliasTokens.filter(token => orderTokenSet.has(token));
          if (sharedTokens.length < 2) {
            continue;
          }
          const coverage = sharedTokens.length / aliasTokens.length;

          if (!bestMatch || coverage > bestMatch.coverage || (coverage === bestMatch.coverage && sharedTokens.length > bestMatch.sharedTokenCount)) {
            bestMatch = {
              template,
              alias: aliasRaw,
              coverage,
              sharedTokenCount: sharedTokens.length
            };
          }
        }

        if (bestMatch && bestMatch.template === template && bestMatch.coverage === 1) {
          break;
        }
      }

      if (!bestMatch) {
        const skuList = templates.flatMap(t => t.skus || []);
        this.logger.warn(`No template alias met minimum token match for SKU ${sku}. Available aliases: ${skuList.join('|')}`);
        return { error: `No matching template found for SKU: ${sku}` };
      }

      const template = bestMatch.template;
      const matchedAlias = bestMatch.alias;
      const matchInfo = `coverage=${bestMatch.coverage.toFixed(2)}, sharedTokens=${bestMatch.sharedTokenCount}`;

      this.logger.log(
        `Selected template ${(template.skus || []).join('|')} for SKU ${sku} (match: ${matchInfo}${matchedAlias ? `, alias: ${matchedAlias}` : ''})`
      );
      
      // Build template description from text elements and include free-text guidance
      const descriptionParts = [];
      
      if (template.textElements && template.textElements.length > 0) {
        template.textElements.forEach(element => {
          descriptionParts.push({
            id: element.id,
            description: element.description,
            defaultValue: element.defaultValue
          });
        });
      }

      const sections: string[] = [
        '字段定义(JSON 数组):',
        JSON.stringify(descriptionParts)
      ];
      if (template.description && template.description.trim().length > 0) {
        sections.push('补充说明:', template.description);
      }
      const templateDescription = sections.join('\n');
      this.logger.log(`Found template description for SKU ${sku}: ${templateDescription}`);
      
      return { templateDescription, templateId: template.id };
      
    } catch (error) {
      this.logger.warn(`Could not find template description for SKU ${sku}: ${error.message}`);
      return { error: `Error finding template for SKU ${sku}: ${error.message}` };
    }
  }

  /**
   * Process order and generate stamp
   */
  async processOrderWithStamp(
    item: any, 
    user?: User,
    personalizationText?: string,
    jobId?: string,
    variationParsingService?: any
  ): Promise<{
    success: boolean;
    stamps?: Array<{ orderId: string; transactionId: string; stampPath: string; recordId?: number }>;
    error?: string;
    cancelled?: boolean;
  }> {
    const orderId = item['Order ID']?.toString() || '';
    const baseTransactionId = item['Transaction ID']?.toString() || '';
    
    if (!orderId || !baseTransactionId) {
      return {
        success: false,
        error: 'Missing order ID or transaction ID'
      };
    }

    if (jobId && this.jobQueueService.isCancelRequested(jobId)) {
      throw new JobCancelledError('任务已取消，订单处理未开始');
    }

    // Check if order already exists
    const existingOrder = await this.etsyOrderRepository.findOne({
      where: { 
        transactionId: baseTransactionId,
        sku: item['SKU']?.toString()
      },
      relations: ['order']
    });

    if (existingOrder) {
      // If order exists and is in stamp_not_generated status, delete it and its related records
      if (existingOrder.order?.status === OrderStatus.STAMP_NOT_GENERATED) {
        // Delete stamp generation records if they exist
        if (existingOrder.stampGenerationRecordIds?.length > 0) {
          await this.orderStampService.deleteStampGenerationRecords(
            existingOrder.stampGenerationRecordIds
          );
        }
        
        // Delete the EtsyOrder
        await this.etsyOrderRepository.remove(existingOrder);
        
        // Delete the main Order
        if (existingOrder.order) {
          await this.orderRepository.remove(existingOrder.order);
        }
        
        this.logger.log(`Deleted existing order ${orderId} with status STAMP_NOT_GENERATED for reimport`);
      } else {
        return {
          success: false,
          error: 'Order with this Transaction ID already exists'
        };
      }
    }
    
    try {
      // Find template for the SKU
      const { templateDescription, error: templateError, templateId } = await this.findTemplateDescription(item);
      
      if (templateError) {
        return { success: false, error: templateError };
      }
      
      // Parse variations
      const originalVariations = personalizationText || item['Variations'];
      
      if (!originalVariations) {
        return {
          success: false,
          error: 'No variations data found in order'
        };
      }
      
      if (!variationParsingService) {
        throw new Error('VariationParsingService is required');
      }
      
      const parsedResult = await variationParsingService.parseVariations(originalVariations, templateDescription);
      
      // Generate stamp
      return await this.generateStamp(item, parsedResult, baseTransactionId, user, templateId, jobId);
      
    } catch (error) {
      if (error instanceof JobCancelledError) {
        throw error;
      }
      this.logger.error(`Error processing order with stamp: ${error.message}`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate stamp for an order
   */
  private async generateStamp(
    item: any,
    parsedResult: any,
    baseTransactionId: string,
    user?: User,
    templateId?: number,
    jobId?: string
  ): Promise<{
    success: boolean;
    stamps?: Array<{ orderId: string; transactionId: string; stampPath: string; recordId?: number }>;
    error?: string;
  }> {
    const orderId = item['Order ID']?.toString() || '';
    const platformOrderDate = item['Date Paid'] ? this.parseDate(item['Date Paid']) : null;
    
    // Double-check if order already exists before creating (race condition protection)
    const existingOrderCheck = await this.etsyOrderRepository.findOne({
      where: { 
        transactionId: baseTransactionId,
        sku: item['SKU']?.toString()
      },
      relations: ['order']
    });

    if (existingOrderCheck) {
      // If order exists and is not in stamp_not_generated status, skip it
      if (existingOrderCheck.order?.status !== OrderStatus.STAMP_NOT_GENERATED) {
        return {
          success: false,
          error: 'Order with this Transaction ID already exists'
        };
      }
      // If order exists but is in stamp_not_generated status, delete it for reimport
      if (existingOrderCheck.stampGenerationRecordIds?.length > 0) {
        await this.orderStampService.deleteStampGenerationRecords(
          existingOrderCheck.stampGenerationRecordIds
        );
      }
      await this.etsyOrderRepository.remove(existingOrderCheck);
      if (existingOrderCheck.order) {
        await this.orderRepository.remove(existingOrderCheck.order);
      }
      this.logger.log(`Deleted existing order ${orderId} with status STAMP_NOT_GENERATED for reimport (double-check)`);
    }
    
    // Create shared order record
    const stamps: Array<{ orderId: string; transactionId: string; stampPath: string; recordId?: number }> = [];
    
    // Create basic order
    const order = this.orderRepository.create({
      status: OrderStatus.STAMP_NOT_GENERATED,
      orderType: OrderType.ETSY,
      platformOrderId: orderId,
      platformOrderDate: platformOrderDate,
      user: user,
      userId: user?.id,
      templateId: templateId,
      searchKey: this.generateSearchKey(item)
    });
    
    // Save the order to get its ID
    await this.orderRepository.save(order);
    
    // Final check before creating EtsyOrder to prevent race conditions
    const finalCheck = await this.etsyOrderRepository.findOne({
      where: { 
        transactionId: baseTransactionId,
        sku: item['SKU']?.toString()
      },
      relations: ['order']
    });

    if (finalCheck) {
      // If order was created by another concurrent request
      if (finalCheck.order?.status !== OrderStatus.STAMP_NOT_GENERATED) {
        // Clean up the order we just created and return error
        await this.orderRepository.remove(order);
        return {
          success: false,
          error: 'Order with this Transaction ID already exists (detected during creation)'
        };
      }
      // If it's in stamp_not_generated status, delete the existing one and continue with our new order
      if (finalCheck.stampGenerationRecordIds?.length > 0) {
        await this.orderStampService.deleteStampGenerationRecords(
          finalCheck.stampGenerationRecordIds
        );
      }
      await this.etsyOrderRepository.remove(finalCheck);
      if (finalCheck.order && finalCheck.order.id !== order.id) {
        await this.orderRepository.remove(finalCheck.order);
      }
      this.logger.log(`Deleted concurrent duplicate order ${orderId} with status STAMP_NOT_GENERATED`);
    }
    
    // Create and save the EtsyOrder entity with shipping information
    const etsyOrder = this.etsyOrderRepository.create({
      orderId,
      transactionId: baseTransactionId,
      order: order,
      sku: item['SKU']?.toString(),
      variations: parsedResult.variations,
      originalVariations: parsedResult.originalVariations,
      stampImageUrls: [],
      stampGenerationRecordIds: [],
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
    
    // One more check before saving EtsyOrder to prevent duplicates
    const preSaveCheck = await this.etsyOrderRepository.findOne({
      where: { 
        transactionId: baseTransactionId,
        sku: item['SKU']?.toString()
      },
      relations: ['order']
    });

    if (preSaveCheck && preSaveCheck.order?.id !== order.id) {
      // Another concurrent request created the EtsyOrder, clean up and return
      await this.orderRepository.remove(order);
      if (preSaveCheck.order?.status !== OrderStatus.STAMP_NOT_GENERATED) {
        return {
          success: false,
          error: 'Order with this Transaction ID already exists (detected before saving EtsyOrder)'
        };
      }
      // If it's in stamp_not_generated status, delete it and continue
      if (preSaveCheck.stampGenerationRecordIds?.length > 0) {
        await this.orderStampService.deleteStampGenerationRecords(
          preSaveCheck.stampGenerationRecordIds
        );
      }
      await this.etsyOrderRepository.remove(preSaveCheck);
      if (preSaveCheck.order) {
        await this.orderRepository.remove(preSaveCheck.order);
      }
      this.logger.log(`Deleted concurrent duplicate EtsyOrder ${orderId} before save`);
    }
    
    // Save the EtsyOrder to get its ID
    await this.etsyOrderRepository.save(etsyOrder);
    
    // Process each personalization group
    for (let i = 0; i < parsedResult.personalizations.length; i++) {
      const personalizationGroup = parsedResult.personalizations[i];
      
      // Create temporary EtsyOrder object for stamp generation
      const tempEtsyOrder = {
        orderId,
        transactionId: baseTransactionId,
        order_id: order.id,
        sku: item['SKU']?.toString(),
        variations: {
          ...parsedResult.variations,
          personalization: personalizationGroup.reduce((acc, curr) => {
            acc[curr.id] = curr.value;
            return acc;
          }, {})
        },
        originalVariations: parsedResult.originalVariations
      };
      
      this.logger.log(`Processing personalization group #${i + 1}: ${JSON.stringify(personalizationGroup)}`);
      
      // Generate stamp for this personalization group
      const stampResult = await this.orderStampService.generateStampFromOrder({
        order: tempEtsyOrder,
        templateId: templateId,
        convertTextToPaths: true,
        jobId
      });

      if (stampResult.cancelled) {
        throw new JobCancelledError(stampResult.error || '任务已取消');
      }

      if (!stampResult.success) {
        this.logger.warn(`Failed to generate stamp for personalization group #${i + 1}: ${stampResult.error}`);
        continue; // Skip this group but continue with others
      }
      
      // Record generated stamp record ID and update EtsyOrder
      if (stampResult.recordId) {
        const stampPath = stampResult.path.replace('uploads/', '/');
        
        // Add to stamps result (use platform order ID, not database ID)
        stamps.push({
          orderId: orderId, // Use platform order ID from Excel
          transactionId: baseTransactionId,
          stampPath,
          recordId: stampResult.recordId
        });
        
        // Update the EtsyOrder with the stamp information
        etsyOrder.stampImageUrls = [...(etsyOrder.stampImageUrls || []), stampPath];
        etsyOrder.stampGenerationRecordIds = [...(etsyOrder.stampGenerationRecordIds || []), stampResult.recordId];
        
        // Save the updated EtsyOrder
        await this.etsyOrderRepository.save(etsyOrder);
      }
    }
    
    // Update order status if at least one stamp was generated
    if (stamps.length > 0) {
      await this.orderRepository.update(
        { id: order.id },
        { status: OrderStatus.STAMP_GENERATED_PENDING_REVIEW }
      );
    }
    
    this.logger.log(`Generated ${stamps.length} stamps for order ${orderId}`);
    
    return {
      success: stamps.length > 0,
      stamps: stamps.length > 0 ? stamps : undefined,
      error: stamps.length === 0 ? 'No stamps were generated for any personalization group' : undefined
    };
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

