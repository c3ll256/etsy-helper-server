import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../entities/order.entity';
import { JobQueueService } from '../../common/services/job-queue.service';
import { User } from '../../users/entities/user.entity';
import { OrderStatus } from '../enums/order.enum';
import * as path from 'path';
import { ExcelProcessingService } from './excel-processing.service';
import { ExcelExportService } from './excel-export.service';
import { OrderProcessingService } from './order-processing.service';
import { VariationParsingService } from './variation-parsing.service';

class JobCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobCancelledError';
  }
}

@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);

  constructor(
    private readonly jobQueueService: JobQueueService,
    private readonly excelProcessingService: ExcelProcessingService,
    private readonly excelExportService: ExcelExportService,
    private readonly orderProcessingService: OrderProcessingService,
    private readonly variationParsingService: VariationParsingService,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
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
      const { data, result } = await this.excelProcessingService.readAndProcessExcelData(file, jobId, user);

      // Generate processing report Excel
      let reportPath: string | null = null;
      try {
        reportPath = await this.excelExportService.createProcessingReportExcel(data, result);
        this.logger.log(`Processing report Excel created at: ${reportPath}`);
      } catch (reportError) {
        this.logger.warn(`Failed to create processing report: ${reportError.message}`);
      }

      // Complete the job
      this.jobQueueService.updateJobProgress(jobId, {
        status: 'completed',
        progress: 100,
        message: `Completed processing ${data.length} orders`,
        result: {
          ...result,
          reportPath: reportPath ? path.relative(process.cwd(), reportPath) : null
        }
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
   * Create Excel file for exporting orders
   */
  async createOrdersExcelForExport(excelData: any[]): Promise<string> {
    return this.excelExportService.createOrdersExcelForExport(excelData);
  }

  /**
   * Create Excel file with stamps for orders
   */
  async createOrdersExcelWithStamps(excelData: any[], fileName: string): Promise<string> {
    return this.excelExportService.createOrdersExcelWithStamps(excelData, fileName);
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
    return this.variationParsingService.parseVariations(variationsString, templateDescription);
  }

  /**
   * Find template description for an order
   */
  public async findTemplateDescription(item: any): Promise<{
    templateDescription?: string;
    error?: string;
    templateId?: number;
  }> {
    return this.orderProcessingService.findTemplateDescription(item);
  }

  /**
   * Prepare data for exporting orders to Excel
   */
  private prepareOrdersExportData(orders: Order[]): any[] {
    return this.excelExportService.prepareOrdersExportData(orders);
  }

  /**
   * Generate Excel file from data
   */
  private generateExcelFile(excelData: any[]): string {
    return this.excelExportService.generateExcelFile(excelData);
  }

  async updateOrderStatus(orderId: string, status: OrderStatus) {
    await this.orderRepository.update(
      { id: orderId },
      { status: status }
    );
  }
}
