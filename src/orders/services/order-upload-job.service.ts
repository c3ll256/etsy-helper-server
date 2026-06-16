import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaginatedResponse } from '../../common/interfaces/pagination.interface';
import { User } from '../../users/entities/user.entity';
import { QueryOrderUploadJobItemsDto } from '../dto/query-order-upload-job-items.dto';
import { QueryOrderUploadJobsDto } from '../dto/query-order-upload-jobs.dto';
import { OrderUploadJobItem, OrderUploadJobItemStatus } from '../entities/order-upload-job-item.entity';
import { OrderUploadJob, OrderUploadJobStatus } from '../entities/order-upload-job.entity';

type JobResultSummary = {
  totalOrders: number;
  newOrdersCreated: number;
  duplicateOrdersSkipped: number;
  failedOrders: number;
  generatedStamps: Array<{ orderId: string; transactionId?: string; stampPath: string }>;
  skippedReasons: Array<{ orderId: string; transactionId?: string; reason: string }>;
  reportPath?: string | null;
};

@Injectable()
export class OrderUploadJobService {
  constructor(
    @InjectRepository(OrderUploadJob)
    private readonly orderUploadJobRepository: Repository<OrderUploadJob>,
    @InjectRepository(OrderUploadJobItem)
    private readonly orderUploadJobItemRepository: Repository<OrderUploadJobItem>,
  ) {}

  async createJob(jobId: string, fileName: string, user: User, orderType: 'stamp' | 'rattle' = 'stamp'): Promise<OrderUploadJob> {
    // 尝试修复可能的编码问题
    let decodedFileName = fileName;
    try {
      // 检查是否是编码问题导致的乱码
      if (fileName && /[^\x00-\x7F]/.test(fileName)) {
        // 如果包含非ASCII字符，尝试解码
        decodedFileName = decodeURIComponent(escape(fileName));
      }
    } catch (error) {
      // 如果解码失败，使用原始文件名
      decodedFileName = fileName;
    }

    const entity = this.orderUploadJobRepository.create({
      jobId,
      userId: user.id,
      shopName: user.shopName || null,
      fileName: decodedFileName,
      orderType,
      status: 'queued',
      progress: 0,
      totalRows: 0,
      successRows: 0,
      failedRows: 0,
      errorMessage: null,
      reportPath: null,
      startedAt: null,
      finishedAt: null,
    });

    return this.orderUploadJobRepository.save(entity);
  }

  async markProcessing(jobId: string, totalRows?: number): Promise<void> {
    await this.orderUploadJobRepository.update({ jobId }, {
      status: 'processing',
      startedAt: new Date(),
      ...(typeof totalRows === 'number' ? { totalRows } : {}),
    });
  }

  async updateProgress(jobId: string, progress: number, totalRows?: number): Promise<void> {
    await this.orderUploadJobRepository.update({ jobId }, {
      progress,
      ...(typeof totalRows === 'number' ? { totalRows } : {}),
    });
  }

  async completeJob(jobId: string, payload: {
    progress?: number;
    totalRows?: number;
    successRows?: number;
    failedRows?: number;
    reportPath?: string | null;
  }): Promise<void> {
    await this.orderUploadJobRepository.update({ jobId }, {
      status: 'completed',
      progress: payload.progress ?? 100,
      totalRows: payload.totalRows ?? 0,
      successRows: payload.successRows ?? 0,
      failedRows: payload.failedRows ?? 0,
      reportPath: payload.reportPath ?? null,
      finishedAt: new Date(),
      errorMessage: null,
    });
  }

  async failJob(jobId: string, errorMessage: string, status: Extract<OrderUploadJobStatus, 'failed' | 'cancelled'> = 'failed'): Promise<void> {
    await this.orderUploadJobRepository.update({ jobId }, {
      status,
      progress: 100,
      errorMessage,
      finishedAt: new Date(),
    });
  }

  async addItem(jobId: string, payload: {
    orderId?: string | null;
    transactionId?: string | null;
    sku?: string | null;
    status: OrderUploadJobItemStatus;
    reason?: string | null;
    detailJson?: Record<string, any> | null;
  }): Promise<OrderUploadJobItem> {
    const entity = this.orderUploadJobItemRepository.create({
      jobId,
      orderId: payload.orderId ?? null,
      transactionId: payload.transactionId ?? null,
      sku: payload.sku ?? null,
      status: payload.status,
      reason: payload.reason ?? null,
      detailJson: payload.detailJson ?? null,
    });

    return this.orderUploadJobItemRepository.save(entity);
  }

  async getJobByJobId(jobId: string): Promise<OrderUploadJob | null> {
    return this.orderUploadJobRepository.findOne({ where: { jobId } });
  }

  async getJobByJobIdForUser(jobId: string, user: User): Promise<OrderUploadJob> {
    const job = await this.getJobByJobId(jobId);
    if (!job) {
      throw new NotFoundException(`Job with ID ${jobId} not found`);
    }

    if (!user.isAdmin && job.userId !== user.id) {
      throw new NotFoundException(`Job with ID ${jobId} not found`);
    }

    return job;
  }

  async listJobs(query: QueryOrderUploadJobsDto, user: User): Promise<PaginatedResponse<OrderUploadJob>> {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    const qb = this.orderUploadJobRepository.createQueryBuilder('job').orderBy('job.created_at', 'DESC').skip(skip).take(limit);

    if (query.status) {
      qb.andWhere('job.status = :status', { status: query.status });
    }

    if (query.orderType) {
      qb.andWhere('job.order_type = :orderType', { orderType: query.orderType });
    }

    if (query.dateFrom) {
      qb.andWhere('date_trunc(\'day\', job.created_at) >= date_trunc(\'day\', :dateFrom::timestamp)', { dateFrom: query.dateFrom });
    }

    if (query.dateTo) {
      qb.andWhere('date_trunc(\'day\', job.created_at) <= date_trunc(\'day\', :dateTo::timestamp)', { dateTo: query.dateTo });
    }

    if (user.isAdmin && query.userId) {
      qb.andWhere('job.user_id = :userId', { userId: query.userId });
    } else if (!user.isAdmin) {
      qb.andWhere('job.user_id = :userId', { userId: user.id });
    }

    const [items, total] = await qb.getManyAndCount();
    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async listJobItems(jobId: string, query: QueryOrderUploadJobItemsDto, user: User): Promise<PaginatedResponse<OrderUploadJobItem>> {
    const job = await this.getJobByJobIdForUser(jobId, user);
    if (!job) {
      throw new NotFoundException(`Job with ID ${jobId} not found`);
    }

    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;
    const qb = this.orderUploadJobItemRepository.createQueryBuilder('item')
      .where('item.job_id = :jobId', { jobId })
      .orderBy('item.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    if (query.status) {
      qb.andWhere('item.status = :status', { status: query.status });
    }

    const [items, total] = await qb.getManyAndCount();
    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  toStatusResponse(job: OrderUploadJob) {
    return {
      status: this.toClientStatus(job.status),
      progress: Number(job.progress || 0),
      message: this.getStatusMessage(job),
      result: this.buildResultSummary(job),
      error: job.errorMessage || undefined,
    };
  }

  private buildResultSummary(job: OrderUploadJob): JobResultSummary {
    return {
      totalOrders: job.totalRows || 0,
      newOrdersCreated: job.successRows || 0,
      duplicateOrdersSkipped: Math.max((job.totalRows || 0) - (job.successRows || 0) - (job.failedRows || 0), 0),
      failedOrders: job.failedRows || 0,
      generatedStamps: [],
      skippedReasons: [],
      reportPath: this.toWebReportPath(job.reportPath),
    };
  }

  private toClientStatus(status: OrderUploadJobStatus): 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' {
    if (status === 'queued') {
      return 'pending';
    }

    return status;
  }

  private getStatusMessage(job: OrderUploadJob): string {
    if (job.status === 'completed') {
      return `Completed processing ${job.totalRows || 0} orders`;
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
      return job.errorMessage || '任务执行失败';
    }

    if (job.status === 'queued') {
      return 'Job created, waiting to start';
    }

    return 'Job is processing';
  }

  private toWebReportPath(reportPath?: string | null): string | null {
    if (!reportPath) {
      return null;
    }

    if (reportPath.startsWith('/uploads/')) {
      return reportPath;
    }

    if (reportPath.startsWith('uploads/')) {
      return `/${reportPath}`;
    }

    return `/uploads/exports/${reportPath.split('/').pop()}`;
  }
}
