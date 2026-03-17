import { Injectable, Logger } from '@nestjs/common';
import { read, utils } from 'xlsx';
import { JobQueueService } from '../../common/services/job-queue.service';
import { User } from '../../users/entities/user.entity';
import { OrderProcessingService } from './order-processing.service';
import { VariationParsingService } from './variation-parsing.service';
import { ProcessingResult } from './excel-export.service';
import { OrderUploadJobService } from './order-upload-job.service';

class JobCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobCancelledError';
  }
}

@Injectable()
export class ExcelProcessingService {
  private readonly logger = new Logger(ExcelProcessingService.name);

  constructor(
    private readonly jobQueueService: JobQueueService,
    private readonly orderProcessingService: OrderProcessingService,
    private readonly variationParsingService: VariationParsingService,
    private readonly orderUploadJobService: OrderUploadJobService,
  ) {}

  /**
   * Read Excel file and process its data
   */
  async readAndProcessExcelData(
    file: Express.Multer.File,
    jobId?: string,
    user?: User
  ): Promise<{
    data: any[];
    result: ProcessingResult;
  }> {
    // 检查文件是否存在
    if (!file || !file.buffer) {
      throw new Error('文件上传失败或文件为空');
    }

    // Read Excel file
    const workbook = read(file.buffer, { type: 'buffer' });

    // 检查工作簿是否有工作表
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new Error('Excel文件中没有找到工作表');
    }

    const worksheet = workbook.Sheets[workbook.SheetNames[0]];

    // 检查工作表是否存在
    if (!worksheet) {
      throw new Error('无法读取Excel工作表');
    }

    const data = utils.sheet_to_json(worksheet);

    // 检查是否有数据
    if (!data || data.length === 0) {
      throw new Error('Excel文件中没有找到数据');
    }

    if (jobId) {
      this.jobQueueService.updateJobProgress(jobId, {
        progress: 10,
        message: `Found ${data.length} orders to process`
      });
      await this.orderUploadJobService.markProcessing(jobId, data.length);
    }

    // Initialize processing results
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const stamps: { orderId: string; transactionId: string; stampPath: string }[] = [];
    const skippedReasons: { orderId: string; transactionId: string; reason: string }[] = [];
    const orderDetails: Array<{
      orderId: string;
      transactionId: string;
      status: 'success' | 'skipped' | 'failed';
      reason?: string;
      stampCount?: number;
      originalData: any;
    }> = [];

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
        await this.orderUploadJobService.updateProgress(jobId, progressPercentage, data.length);
      }

      try {
        const { orderId, transactionId, validationError } = this.orderProcessingService.validateOrderData(item);
        
        if (validationError) {
          skipped++;
          skippedReasons.push({
            orderId: orderId || 'Unknown',
            transactionId: transactionId || 'Unknown',
            reason: validationError
          });
          orderDetails.push({
            orderId: orderId || 'Unknown',
            transactionId: transactionId || 'Unknown',
            status: 'skipped',
            reason: validationError,
            originalData: item
          });
          if (jobId) {
            await this.orderUploadJobService.addItem(jobId, {
              orderId: orderId || 'Unknown',
              transactionId: transactionId || 'Unknown',
              sku: item['SKU']?.toString() || null,
              status: 'skipped',
              reason: validationError,
              detailJson: { originalData: item },
            });
          }
          continue;
        }

        // Process order and generate stamp
        const orderResult = await this.orderProcessingService.processOrderWithStamp(
          item, 
          user, 
          undefined, 
          jobId,
          this.variationParsingService
        );
        
        if (orderResult.success && orderResult.stamps && orderResult.stamps.length > 0) {
          created += orderResult.stamps.length;
          stamps.push(...orderResult.stamps);
          orderDetails.push({
            orderId,
            transactionId,
            status: 'success',
            stampCount: orderResult.stamps.length,
            originalData: item
          });
          if (jobId) {
            await this.orderUploadJobService.addItem(jobId, {
              orderId,
              transactionId,
              sku: item['SKU']?.toString() || null,
              status: 'success',
              reason: null,
              detailJson: { stampCount: orderResult.stamps.length },
            });
          }
          this.logger.log(`Successfully processed order ${orderId} with ${orderResult.stamps.length} personalizations`);
        } else {
          skipped++;
          const errorReason = orderResult.error || 'Unknown error during order processing';
          skippedReasons.push({
            orderId,
            transactionId,
            reason: errorReason
          });
          orderDetails.push({
            orderId,
            transactionId,
            status: 'skipped',
            reason: errorReason,
            originalData: item
          });
          if (jobId) {
            await this.orderUploadJobService.addItem(jobId, {
              orderId,
              transactionId,
              sku: item['SKU']?.toString() || null,
              status: 'skipped',
              reason: errorReason,
              detailJson: { originalData: item },
            });
          }
        }
      } catch (error) {
        if (error instanceof JobCancelledError) {
          throw error;
        }
        this.logger.error(`Failed to process order:`, error);
        failed++;
        const orderId = item['Order ID']?.toString() || 'Unknown';
        const transactionId = item['Transaction ID']?.toString() || 'Unknown';
        const errorMessage = error.message || 'Unknown error';
        skippedReasons.push({
          orderId,
          transactionId,
          reason: errorMessage
        });
        orderDetails.push({
          orderId,
          transactionId,
          status: 'failed',
          reason: errorMessage,
          originalData: item
        });
        if (jobId) {
          await this.orderUploadJobService.addItem(jobId, {
            orderId,
            transactionId,
            sku: item['SKU']?.toString() || null,
            status: 'failed',
            reason: errorMessage,
            detailJson: { originalData: item },
          });
        }
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
        stamps,
        orderDetails
      }
    };
  }
}
