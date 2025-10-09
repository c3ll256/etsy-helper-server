import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { read, utils, write, WorkSheet, WorkBook } from 'xlsx';
import { OrderStampService } from '../../stamps/services/order-stamp.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../entities/order.entity';
import { EtsyOrder } from '../entities/etsy-order.entity';
import { JobQueueService } from '../../common/services/job-queue.service';
import { StampGenerationRecord } from '../../stamps/entities/stamp-generation-record.entity';
import * as path from 'path';
import * as fs from 'fs';
import { User } from '../../users/entities/user.entity';
import { AliyunService } from 'src/common/services/aliyun.service';
import { OrderStatus, OrderType } from '../enums/order.enum';
import * as ExcelJS from 'exceljs';
import * as dayjs from 'dayjs';
import * as customParseFormat from 'dayjs/plugin/customParseFormat';
import { RemoteAreaService } from 'src/common/services/remote-area.service';
import * as QRCode from 'qrcode';
import { createCanvas, loadImage } from 'canvas';

// Initialize dayjs plugins
dayjs.extend(customParseFormat);

class JobCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobCancelledError';
  }
}

type ProcessingResult = {
  total: number;
  created: number;
  skipped: number;
  skippedReasons: { orderId: string; transactionId: string; reason: string }[];
  failed: number;
  stamps: { orderId: string; transactionId: string; stampPath: string }[];
};

@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);

  constructor(
    private readonly orderStampService: OrderStampService,
    private readonly jobQueueService: JobQueueService,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(EtsyOrder)
    private readonly etsyOrderRepository: Repository<EtsyOrder>,
    @InjectRepository(StampGenerationRecord)
    private readonly stampGenerationRecordRepository: Repository<StampGenerationRecord>,
    private readonly aliyunService: AliyunService,
    private readonly remoteAreaService: RemoteAreaService,
  ) {}

  /**
   * Process Excel file asynchronously with progress tracking
   */
  async processExcelFileAsync(file: Express.Multer.File, user?: User): Promise<string> {
    const jobId = this.jobQueueService.createJob(user?.id);
    
    this.processExcelFileWithProgress(file, jobId, user).catch(error => {
      this.logger.error(`Error in background processing: ${error.message}`, error.stack);
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'failed',
        progress: 100,
        message: `Failed to process file: ${error.message}`,
        error: error.message
      });
    });
    
    return jobId;
  }

  /**
   * Create Excel file for exporting orders
   */
  async createOrdersExcelForExport(excelData: any[]): Promise<string> {
    try {
      // Build workbook and worksheet with ExcelJS to support images (QR codes)
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('订单信息');

      // Define columns (place QR as the last column; merge date+time)
      worksheet.columns = [
        { header: '序号', key: 'index', width: 10 },
        { header: '订单号', key: 'orderId', width: 20 },
        { header: '客户名称', key: 'customerName', width: 20 },
        { header: '收件人名称', key: 'recipientName', width: 20 },
        { header: 'SKU', key: 'sku', width: 20 },
        { header: '解析前的variants', key: 'variantsBefore', width: 40 },
        { header: '解析后的variants', key: 'variantsAfter', width: 40 },
        { header: '下单时间', key: 'orderDateTime', width: 20 },
        { header: '文件名', key: 'fileName', width: 30 },
        { header: '二维码', key: 'qr', width: 22 }
      ];

      // Style header
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      headerRow.height = 25;

      // Pre-calc the qr column index (0-based for image anchor)
      const qrColZeroBased = worksheet.columns.findIndex(c => c.key === 'qr');

      for (let i = 0; i < excelData.length; i++) {
        const rowData = excelData[i];
        const rowNumber = i + 2; // data starts at row 2

        // Extract values
        const orderId: string = rowData['订单号'] || '';
        const customerName: string = rowData['客户名称'] || '';
        const recipientName: string = rowData['收件人名称'] || '';
        const sku: string = rowData['SKU'] || '';
        const variantsBefore: string = rowData['解析前的variants'] || '';
        const variantsAfter: string = rowData['解析后的variants'] || '';
        const orderDateTimeRaw: Date | string = rowData['下单时间'] || rowData['下单日期'] || rowData['导入时间'];
        const fileName: string = rowData['文件名'] || '';

        // Format combined datetime
        const orderDateTime = orderDateTimeRaw ? new Date(orderDateTimeRaw) : null;
        const orderDateTimeText = orderDateTime ? dayjs(orderDateTime).format('YYYY-MM-DD HH:mm:ss') : '';

        // Fill row cells
        const dataRow = worksheet.getRow(rowNumber);
        dataRow.getCell('index').value = rowData['序号'] || '';
        dataRow.getCell('orderId').value = orderId;
        dataRow.getCell('customerName').value = customerName;
        dataRow.getCell('recipientName').value = recipientName;
        dataRow.getCell('sku').value = sku;
        dataRow.getCell('variantsBefore').value = variantsBefore;
        dataRow.getCell('variantsAfter').value = variantsAfter;
        dataRow.getCell('orderDateTime').value = orderDateTimeText;
        dataRow.getCell('fileName').value = fileName;

        // Adjust row height to make room for QR + caption
        dataRow.height = 120;

        // QR Code generation and placement (compose QR + caption into one image)
        if (orderId) {
          try {
            const dataUrl = await QRCode.toDataURL(orderId, { type: 'image/png', scale: 6, margin: 1 } as any);
            const qrImage = await loadImage(dataUrl);
            const padding = 8;
            const text = orderId;

            // Measure text using a temporary context
            const measureCanvas = createCanvas(1, 1);
            const measureCtx = measureCanvas.getContext('2d');
            measureCtx.font = '16px sans-serif';
            const textWidth = Math.ceil(measureCtx.measureText(text).width);
            const textHeight = 22; // approximate line height for 16px font

            const compositeWidth = Math.max(qrImage.width + padding * 2, textWidth + padding * 2);
            const compositeHeight = padding + qrImage.height + padding + textHeight;

            const canvas = createCanvas(compositeWidth, compositeHeight);
            const ctx = canvas.getContext('2d');
            // White background
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, compositeWidth, compositeHeight);
            // Draw QR centered
            const qrX = Math.floor((compositeWidth - qrImage.width) / 2);
            ctx.drawImage(qrImage, qrX, padding);
            // Draw caption centered
            ctx.fillStyle = '#000000';
            ctx.font = '16px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const captionY = padding + qrImage.height + Math.floor(textHeight / 2);
            ctx.fillText(text, compositeWidth / 2, captionY);

            const composedBuffer = canvas.toBuffer('image/png');
            const imageId = workbook.addImage({ base64: composedBuffer.toString('base64'), extension: 'png' });

            // Preserve aspect ratio, fit within 120x120 box
            const maxW = 120;
            const maxH = 120;
            const scale = Math.min(maxW / compositeWidth, maxH / compositeHeight, 1);
            const extWidth = Math.round(compositeWidth * scale);
            const extHeight = Math.round(compositeHeight * scale);

            worksheet.addImage(imageId, {
              tl: { col: qrColZeroBased, row: rowNumber - 1 },
              ext: { width: extWidth, height: extHeight }
            });
          } catch (e) {
            const qrCell = dataRow.getCell('qr');
            qrCell.value = 'QR生成失败';
            qrCell.alignment = { vertical: 'middle', horizontal: 'center' };
            this.logger.warn(`Failed to generate QR for order ${orderId}: ${e.message}`);
          }
        }

        // Style alignment for the row
        dataRow.alignment = { vertical: 'middle', horizontal: 'center' };
      }

      // Create output directory
      const exportDir = path.join(process.cwd(), 'uploads', 'exports');
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }

      // Save workbook
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const excelFileName = `orders_info_${timestamp}.xlsx`;
      const excelFilePath = path.join(exportDir, excelFileName);
      await workbook.xlsx.writeFile(excelFilePath);

      this.logger.log(`Excel file with QR created at: ${excelFilePath}`);
      return excelFilePath;
    } catch (error) {
      this.logger.error(`Failed to create Excel file: ${error.message}`, error.stack);
      throw new Error(`Failed to create Excel file: ${error.message}`);
    }
  }

  /**
   * Parse order variations using LLM
   */
  public async parseVariations(variationsString: string, templateDescription?: string): Promise<{
    variations: { [key: string]: string };
    hasMultiple: boolean;
    personalizations: Array<Array<{ id: string; value: string }>>;
    originalVariations: string;
  }> {
    if (!variationsString) {
      return {
        variations: null,
        hasMultiple: false,
        personalizations: [],
        originalVariations: ''
      };
    }
    
    try {
      const prompt = this.buildParsingPrompt();
      const userPrompt = this.buildUserPrompt(variationsString, templateDescription);

      try {
        const parsedResult = await this.aliyunService.generateJson(userPrompt, { systemPrompt: prompt });
        this.logger.log(`Parsed result: ${JSON.stringify(parsedResult)}`);
        return {
          ...parsedResult,
          originalVariations: variationsString
        };
      } catch (jsonError) {
        this.logger.warn(`Failed to parse variations using GLM JSON: ${jsonError.message}`);
        throw new Error(`Failed to parse variations: ${jsonError.message}`);
      }
    } catch (error) {
      this.logger.error(`Error parsing variations using LLM: ${error.message}`, error);
      throw error;
    }
  }

  /**
   * Process Excel file with progress tracking
   */
  private async processExcelFileWithProgress(file: Express.Multer.File, jobId: string, user?: User): Promise<void> {
    try {
      // Initial progress update
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'processing',
        progress: 5,
        message: 'Reading Excel file...'
      });

      // Read and process the data
      const { data, result } = await this.readAndProcessExcelData(file, jobId, user);

      // Complete the job
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'completed',
        progress: 100,
        message: `Completed processing ${data.length} orders`,
        result
      });
      
      // Set cleanup timeout for this job
      this.jobQueueService.startJobCleanup(jobId);
      
    } catch (error) {
      if (error instanceof JobCancelledError) {
        this.logger.warn(`Excel processing cancelled: ${error.message}`);
        const currentProgress = this.jobQueueService.getJobProgress(jobId)?.progress ?? 0;
        this.jobQueueService.markJobCancelled(jobId, {
          progress: currentProgress,
          message: error.message || '任务已取消'
        });
        return;
      }
      this.logger.error(`Failed to process Excel file: ${error.message}`, error.stack);
      const status = this.jobQueueService.getJobProgress(jobId)?.status === 'cancelled' ? 'cancelled' : 'failed';
      this.jobQueueService.updateJobProgress(jobId, {
        status,
        progress: 100,
        message: `Failed to process file: ${error.message}`,
        error: error.message
      });
    }
  }

  /**
   * Read Excel file and process its data
   */
  private async readAndProcessExcelData(
    file: Express.Multer.File, 
    jobId?: string, 
    user?: User
  ): Promise<{ 
    data: any[]; 
    result: ProcessingResult;
  }> {
    // Read Excel file
    const workbook = read(file.buffer, { type: 'buffer' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = utils.sheet_to_json(worksheet);

    if (jobId) {
      this.jobQueueService.updateJobProgress(jobId, {
        progress: 10,
        message: `Found ${data.length} orders to process`
      });
    }

    // Initialize processing results
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const stamps: { orderId: string; transactionId: string; stampPath: string }[] = [];
    const skippedReasons: { orderId: string; transactionId: string; reason: string }[] = [];

    // Process each order
    for (let i = 0; i < data.length; i++) {
      if (jobId && this.jobQueueService.isCancelRequested(jobId)) {
        const progressPercentage = 10 + Math.floor((i / data.length) * 85);
        const message = `任务在处理第 ${i + 1} 个订单时被取消`;
        this.jobQueueService.markJobCancelled(jobId, {
          progress: progressPercentage,
          message
        });
        throw new JobCancelledError(message);
      }
      const item = data[i];
      
      if (jobId) {
        const progressPercentage = 10 + Math.floor((i / data.length) * 85);
        this.jobQueueService.updateJobProgress(jobId, {
          progress: progressPercentage,
          message: `Processing order ${i+1} of ${data.length}...`
        });
      }

      try {
        const { orderId, transactionId, validationError } = this.validateOrderData(item);
        
        if (validationError) {
          skipped++;
          skippedReasons.push({
            orderId: orderId || 'Unknown',
            transactionId: transactionId || 'Unknown',
            reason: validationError
          });
          continue;
        }

        // Process order and generate stamp
        const orderResult = await this.processOrderWithStamp(item, user, undefined, jobId);
        
        if (orderResult.success && orderResult.stamps && orderResult.stamps.length > 0) {
          created += orderResult.stamps.length;
          stamps.push(...orderResult.stamps);
          this.logger.log(`Successfully processed order ${orderId} with ${orderResult.stamps.length} personalizations`);
        } else {
          skipped++;
          skippedReasons.push({
            orderId,
            transactionId,
            reason: orderResult.error || 'Unknown error during order processing'
          });
        }
      } catch (error) {
        if (error instanceof JobCancelledError) {
          throw error;
        }
        this.logger.error(`Failed to process order:`, error);
        failed++;
        const orderId = item['Order ID']?.toString() || 'Unknown';
        const transactionId = item['Transaction ID']?.toString() || 'Unknown';
        skippedReasons.push({
          orderId,
          transactionId,
          reason: error.message
        });
      }
    }

    // Return processing results
    return {
      data,
      result: {
        total: data.length,
        created,
        skipped,
        skippedReasons,
        failed,
        stamps
      }
    };
  }

  /**
   * Validate order data from Excel
   */
  private validateOrderData(item: any): {
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

    // Check if order with same Transaction ID exists
    return { orderId, transactionId };
  }

  /**
   * Find template description for an order
   */
  public async findTemplateDescription(item: any): Promise<{
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
    
    // Extract base part of SKU (e.g., from "AD-110-XX" to "AD-110")
    const skuBase = sku.split('-').slice(0, 2).join('-');
    
    try {
      const templates = await this.orderStampService.findTemplatesBySku(sku, skuBase);
      
      if (!templates || templates.length === 0) {
        this.logger.warn(`No template found for SKU ${sku}`);
        return { error: `No matching template found for SKU: ${sku}` };
      }
      
      const normalizeSkuValue = (value: string): string => (value || '').toLowerCase().trim();
      const tokenizeSkuValue = (value: string): string[] =>
        normalizeSkuValue(value)
          .split(/[^a-z0-9]+/)
          .filter(token => token.length > 0);
      const longestCommonSubstringLength = (a: string, b: string): number => {
        if (!a || !b) return 0;
        const lenA = a.length;
        const lenB = b.length;
        let maxLen = 0;
        const dp: number[] = new Array(lenB + 1).fill(0);

        for (let i = 1; i <= lenA; i++) {
          let prev = 0;
          for (let j = 1; j <= lenB; j++) {
            const temp = dp[j];
            if (a[i - 1] === b[j - 1]) {
              dp[j] = prev + 1;
              if (dp[j] > maxLen) {
                maxLen = dp[j];
              }
            } else {
              dp[j] = 0;
            }
            prev = temp;
          }
        }

        return maxLen;
      };

      const normalizedSku = normalizeSkuValue(sku);
      const orderTokens = tokenizeSkuValue(sku);
      const orderTokenSet = new Set(orderTokens);

      type MatchCandidate = {
        template: any;
        alias?: string;
        coverage: number;
        sharedTokenCount: number;
        substringLength: number;
      };

      const isCandidateBetter = (candidate: MatchCandidate, current?: MatchCandidate): boolean => {
        if (!current) return true;
        if (candidate.coverage !== current.coverage) {
          return candidate.coverage > current.coverage;
        }
        if (candidate.sharedTokenCount !== current.sharedTokenCount) {
          return candidate.sharedTokenCount > current.sharedTokenCount;
        }
        if (candidate.substringLength !== current.substringLength) {
          return candidate.substringLength > current.substringLength;
        }
        return (candidate.alias?.length || 0) > (current.alias?.length || 0);
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
              sharedTokenCount: tokenizeSkuValue(aliasRaw).length,
              substringLength: normalizedAlias.length
            };
            break;
          }

          const aliasTokens = tokenizeSkuValue(aliasRaw);
          if (aliasTokens.length === 0) {
            continue;
          }

          const sharedTokens = aliasTokens.filter(token => orderTokenSet.has(token));
          const coverage = sharedTokens.length / aliasTokens.length;
          const substringLength = longestCommonSubstringLength(normalizedAlias, normalizedSku);

          const candidate: MatchCandidate = {
            template,
            alias: aliasRaw,
            coverage,
            sharedTokenCount: sharedTokens.length,
            substringLength
          };

          if (isCandidateBetter(candidate, bestMatch)) {
            bestMatch = candidate;
          }
        }

        if (bestMatch && bestMatch.template === template && bestMatch.coverage === 1) {
          break;
        }
      }

      const template = bestMatch ? bestMatch.template : templates[0];
      const matchedAlias = bestMatch?.alias;
      const matchInfo = bestMatch
        ? `coverage=${bestMatch.coverage.toFixed(2)}, sharedTokens=${bestMatch.sharedTokenCount}, substringLength=${bestMatch.substringLength}`
        : 'fallback';

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
  private async processOrderWithStamp(
    item: any, 
    user?: User,
    personalizationText?: string,
    jobId?: string
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
      
      const parsedResult = await this.parseVariations(originalVariations, templateDescription);
      
      // Generate stamp
      return await this.generateStamp(item, parsedResult, baseTransactionId, user, templateId, jobId);
      
    } catch (error) {
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
        
        // Add to stamps result
        stamps.push({
          orderId: order.id,
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
   * Prepare data for exporting orders to Excel
   */
  private prepareOrdersExportData(orders: Order[]): any[] {
    const excelData = [];
    
    // 按订单号(platformOrderId 或 orderId)对订单进行分组
    const orderGroups = new Map<string, Array<{order: Order, stamps: string[]}>>(); 
    
    for (const order of orders) {
      if (order.orderType === 'etsy' && order.etsyOrder) {
        // 使用平台订单ID或Etsy订单ID作为分组键
        const groupKey = order.platformOrderId || order.etsyOrder.orderId || order.id.toString();
        
        if (!orderGroups.has(groupKey)) {
          orderGroups.set(groupKey, []);
        }
        
        // 将订单及其图章URL添加到组中
        orderGroups.get(groupKey).push({
          order,
          stamps: order.etsyOrder.stampImageUrls || []
        });
      }
    }
    
    // 对订单组进行排序
    const sortedOrderGroupKeys = Array.from(orderGroups.keys()).sort();
    let orderIndex = 0;
    
    // 处理每个订单组
    for (const groupKey of sortedOrderGroupKeys) {
      const orderWithStamps = orderGroups.get(groupKey);
      orderIndex++; // 每个不同的订单号递增订单索引
      
      // 收集该订单组的所有图章URL
      const allStampsInGroup: Array<{stamp: string, order: Order}> = [];
      
      for (const item of orderWithStamps) {
        for (const stamp of item.stamps) {
          allStampsInGroup.push({
            stamp,
            order: item.order
          });
        }
      }
      
      // 为该订单组的每个图章创建Excel数据行
      for (let stampIndex = 0; stampIndex < allStampsInGroup.length; stampIndex++) {
        const { stamp, order } = allStampsInGroup[stampIndex];
        
        excelData.push({
          '序号': `${orderIndex}-${stampIndex + 1}`,
          '订单号': order.etsyOrder.orderId,
          'SKU': order.etsyOrder.sku || 'N/A',
          '解析前的variants': order.etsyOrder.originalVariations || 'N/A',
          '解析后的variants': JSON.stringify(order.etsyOrder.variations) || 'N/A',
          '下单日期': order.platformOrderDate || order.createdAt,
          '文件名': `${orderIndex}-${stampIndex + 1}${path.extname(stamp)}`
        });
      }
    }
    
    return excelData;
  }

  /**
   * Generate Excel file from data
   */
  private generateExcelFile(excelData: any[]): string {
    // Create workbook and worksheet
    const worksheet: WorkSheet = utils.json_to_sheet(excelData);
    const workbook: WorkBook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, '订单信息');
    
    // Set column widths
    worksheet['!cols'] = [
      { wch: 10 },  // 序号
      { wch: 20 },  // 订单号
      { wch: 15 },  // SKU
      { wch: 40 },  // 解析前的variants
      { wch: 40 },  // 解析后的variants
      { wch: 20 },  // 下单日期
      { wch: 15 },  // 文件名
    ];
    
    // Create output directory
    const exportDir = path.join(process.cwd(), 'uploads', 'exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    
    // Create file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const excelFileName = `orders_info_${timestamp}.xlsx`;
    const excelFilePath = path.join(exportDir, excelFileName);
    
    const excelBuffer = write(workbook, { bookType: 'xlsx', type: 'buffer' });
    fs.writeFileSync(excelFilePath, excelBuffer);
    
    this.logger.log(`Excel file created at: ${excelFilePath}`);
    
    return excelFilePath;
  }

  /**
   * Build prompt for parsing variations
   */
  private buildParsingPrompt(): string {
    return `
你是一位解析订单的专家。你需要完成两个任务：
1. 将原始的变量字符串解析为JSON格式
2. 分析是否包含多个个性化信息，并将每个个性化信息根据模板描述 (description) 解析为结构化数据

请按照以下格式返回JSON:
{
  "variations": {
    "字段名1": "值1",
    "字段名2": "值2",
    ...
  },
  "hasMultiple": true/false, // 是否包含多个 Personalization 信息
  "personalizations": [    // 每个 Personalization 的结构化数据
    [
      {
        "id": "id_1",
        "value": "值1"
      },
      {
        "id": "id_2",
        "value": "值2"
      },
      ...
    ],
    ... // 可能还有更多个性化信息
  ]
}

特别注意:
1. 个性化信息 (personalizations) 是最重要的字段，必须确保100%完整保留，尤其是地址、名称等信息
2. 如果只有一个个性化信息，hasMultiple 应为 false
3. 保持原始文本的精确性，不要添加或删除内容
4. 一定要保证填写每一个字段，根据模版字段的描述 (description) 来匹配信息应该填写到哪个字段
5. 注意，有的时候会有多个名称一类的在一行，可能会以逗号或者空格隔开，这种情况下不要拆分为多个个性化信息
6. 仅输出JSON对象，不要有任何其他文本

注意！！！每个结构化数据的 key-value 的 key 是模版描述中的 id (不要自己编造，严格按照模版描述中的 id)！！！

例如，对于如下原始变量:
"Stamp Type:Wood Stamp + ink pad,Design Options:#4,Personalization:The Bradys
50 South Circle V Drive
Manila, UT 84046"

以及如下模版:
[
  {"id":"name","description":"名字或团体名称","defaultValue":"default"},
  {"id":"address_line1","description":"地址栏一","defaultValue":"address1"},
  {"id":"address_line2","description":"地址栏二","defaultValue":"address2"},
  ... // 可能还有更多字段
]

正确的解析应为如下:
{
  "variations": {
    "Stamp Type": "Wood Stamp + ink pad",
    "Design Options": "#4"
  },
  "hasMultiple": false,
  "personalizations": [
    [
      {
        "id": "name",
        "value": "The Bradys"
      },
      {
        "id": "address_line1",
        "value": "50 South Circle V Drive"
      },
      {
        "id": "address_line2",
        "value": "Manila, UT 84046"
      }
    ]
  ]
}
`;
  }

  /**
   * Build user prompt for parsing variations
   */
  private buildUserPrompt(variationsString: string, templateDescription?: string): string {
    return `${templateDescription ? `
模版如下，请根据模版字段的描述 (description) 来理解和提取相关字段：
${templateDescription}
` : ''}

原始变量字符串:
${variationsString}`;
  }

  async updateOrderStatus(orderId: string, status: OrderStatus) {
    await this.orderRepository.update(
      { id: orderId },
      { status: status }
    );
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
   * Create Excel file with stamps for orders
   */
  async createOrdersExcelWithStamps(excelData: any[], fileName: string): Promise<string> {
    try {
      // Create workbook and worksheet
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('订单印章');

      // Set column widths and properties (add last QR column, merge datetime)
      worksheet.columns = [
        { header: '序号', key: 'index', width: 10 },
        { header: '订单号', key: 'orderId', width: 20 },
        { header: '设计图', key: 'image', width: 40 },
        { header: '数量', key: 'quantity', width: 10 },
        { header: '尺寸', key: 'size', width: 15 },
        { header: 'SKU', key: 'sku', width: 20 },
        { header: '店铺', key: 'shop', width: 20 },
        { header: '下单时间', key: 'orderDateTime', width: 22 },
        { header: '二维码', key: 'qr', width: 22 }
      ];

      // Style the header row
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      headerRow.height = 25;

      // Pre-calc the qr column index (0-based for image anchor)
      const qrColZeroBased = worksheet.columns.findIndex(c => c.key === 'qr');

      // Process each row
      for (let i = 0; i < excelData.length; i++) {
        const row = excelData[i];
        const rowNumber = i + 2; // +2 because row 1 is header

        // Add row data
        const dataRow = worksheet.getRow(rowNumber);
        dataRow.getCell('index').value = row['序号'];
        dataRow.getCell('orderId').value = row['订单号'];
        dataRow.getCell('quantity').value = row['数量'];
        dataRow.getCell('size').value = row['尺寸'];
        dataRow.getCell('sku').value = row['SKU'];
        dataRow.getCell('shop').value = row['店铺'];
        const dtRaw = row['下单时间'] || row['导入时间'];
        dataRow.getCell('orderDateTime').value = dtRaw ? dayjs(new Date(dtRaw)).format('YYYY-MM-DD HH:mm:ss') : '';

        // Set row height for image
        dataRow.height = 120;

        // Handle image
        if (row['设计图']) {
          try {
            const imagePath = path.join(process.cwd(), 'uploads', row['设计图']);
            if (fs.existsSync(imagePath)) {
              const imageId = workbook.addImage({
                filename: imagePath,
                extension: 'png',
              });

              // Calculate image dimensions based on template size
              const templateWidth = parseInt(row['尺寸'].split('x')[0]);
              const templateHeight = parseInt(row['尺寸'].split('x')[1]);
              const aspectRatio = templateWidth / templateHeight;

              // Base size (in Excel units)
              const baseHeight = 100;
              const width = baseHeight * aspectRatio;
              const height = baseHeight;

              // Add image to worksheet with calculated dimensions
              worksheet.addImage(imageId, {
                tl: { col: 2, row: rowNumber - 1 }, // -1 because row is 1-based
                ext: { width, height }
              });
            } else {
              dataRow.getCell('image').value = '图片不存在';
              this.logger.warn(`Image not found: ${imagePath}`);
            }
          } catch (error) {
            this.logger.error(`Failed to process image for row ${rowNumber}: ${error.message}`);
            dataRow.getCell('image').value = '图片处理失败';
          }
        }

        // QR image composed with caption (orderId)
        const orderId = row['订单号'];
        if (orderId) {
          try {
            const dataUrl = await QRCode.toDataURL(orderId, { type: 'image/png', scale: 6, margin: 1 } as any);
            const qrImage = await loadImage(dataUrl);
            const padding = 8;
            const text = orderId;

            // Measure text using a temporary context
            const measureCanvas = createCanvas(1, 1);
            const measureCtx = measureCanvas.getContext('2d');
            measureCtx.font = '16px sans-serif';
            const textWidth = Math.ceil(measureCtx.measureText(text).width);
            const textHeight = 22; // approximate line height for 16px font

            const compositeWidth = Math.max(qrImage.width + padding * 2, textWidth + padding * 2);
            const compositeHeight = padding + qrImage.height + padding + textHeight;

            const canvas = createCanvas(compositeWidth, compositeHeight);
            const ctx = canvas.getContext('2d');
            // White background
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, compositeWidth, compositeHeight);
            // Draw QR centered
            const qrX = Math.floor((compositeWidth - qrImage.width) / 2);
            ctx.drawImage(qrImage, qrX, padding);
            // Draw caption centered
            ctx.fillStyle = '#000000';
            ctx.font = '16px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const captionY = padding + qrImage.height + Math.floor(textHeight / 2);
            ctx.fillText(text, compositeWidth / 2, captionY);

            const composedBuffer = canvas.toBuffer('image/png');
            const imageId = workbook.addImage({ base64: composedBuffer.toString('base64'), extension: 'png' });

            // Preserve aspect ratio, fit within 120x120 box
            const maxW = 120;
            const maxH = 120;
            const scale = Math.min(maxW / compositeWidth, maxH / compositeHeight, 1);
            const extWidth = Math.round(compositeWidth * scale);
            const extHeight = Math.round(compositeHeight * scale);

            worksheet.addImage(imageId, {
              tl: { col: qrColZeroBased, row: rowNumber - 1 },
              ext: { width: extWidth, height: extHeight }
            });
          } catch (e) {
            const qrCell = dataRow.getCell('qr');
            qrCell.value = 'QR生成失败';
            qrCell.alignment = { vertical: 'middle', horizontal: 'center' };
            this.logger.warn(`Failed to generate QR for order ${orderId}: ${e.message}`);
          }
        }

        // Style the row
        dataRow.alignment = { vertical: 'middle', horizontal: 'center' };
      }

      // Create output directory
      const exportDir = path.join(process.cwd(), 'uploads', 'exports');
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }

      // Save workbook
      const filePath = path.join(exportDir, fileName);
      await workbook.xlsx.writeFile(filePath);

      // Return relative path
      return path.relative(process.cwd(), filePath);
    } catch (error) {
      this.logger.error(`Failed to create Excel file with stamps: ${error.message}`, error.stack);
      throw new Error(`Failed to create Excel file: ${error.message}`);
    }
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