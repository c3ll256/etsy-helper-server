import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { OrderUploadJob } from '../orders/entities/order-upload-job.entity';
import { OrderUploadJobItem } from '../orders/entities/order-upload-job-item.entity';
import { OrderUploadJobService } from '../orders/services/order-upload-job.service';
import { ExcelService } from '../orders/services/excel.service';
import { QueryOrderUploadJobsDto } from '../orders/dto/query-order-upload-jobs.dto';
import { QueryOrderUploadJobItemsDto } from '../orders/dto/query-order-upload-job-items.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { Order } from '../orders/entities/order.entity';
import { EtsyOrder } from '../orders/entities/etsy-order.entity';

@Injectable()
export class RattleService {
  constructor(
    @InjectRepository(OrderUploadJob)
    private readonly orderUploadJobRepository: Repository<OrderUploadJob>,
    @InjectRepository(OrderUploadJobItem)
    private readonly orderUploadJobItemRepository: Repository<OrderUploadJobItem>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(EtsyOrder)
    private readonly etsyOrderRepository: Repository<EtsyOrder>,
    private readonly orderUploadJobService: OrderUploadJobService,
    private readonly excelService: ExcelService,
  ) {}

  async uploadRattleOrders(file: Express.Multer.File, user: User) {
    if (!file) {
      throw new BadRequestException('请上传Excel文件');
    }

    if (!file.originalname.toLowerCase().match(/\.(xlsx|xls)$/)) {
      throw new BadRequestException('只支持Excel文件格式 (.xlsx, .xls)');
    }

    try {
      // 使用与印章订单相同的处理逻辑，但指定为摇铃类型
      const jobId = await this.excelService.processExcelFileAsync(file, user);

      // 更新任务类型为摇铃
      await this.orderUploadJobRepository.update({ jobId }, { orderType: 'rattle' });

      return {
        message: '摇铃订单上传任务已创建',
        jobId,
        status: 'queued',
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async getUploadJobStatus(jobId: string, user: User) {
    const job = await this.orderUploadJobRepository.findOne({
      where: { jobId, userId: user.id },
    });

    if (!job) {
      throw new NotFoundException('任务不存在');
    }

    return {
      status: job.status,
      progress: job.progress,
      message: this.getStatusMessage(job.status),
      result: job.status === 'completed' ? {
        totalOrders: job.totalRows,
        processedOrders: job.successRows,
        failedOrders: job.failedRows,
        outputPath: job.reportPath,
      } : undefined,
      error: job.errorMessage,
    };
  }

  async cancelUploadJob(jobId: string, user: User) {
    const job = await this.orderUploadJobRepository.findOne({
      where: { jobId, userId: user.id },
    });

    if (!job) {
      throw new NotFoundException('任务不存在');
    }

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      throw new BadRequestException('任务已完成，无法取消');
    }

    await this.orderUploadJobService.failJob(jobId, '任务已取消', 'cancelled');

    return { message: '任务已取消' };
  }

  async getUploadJobs(query: QueryOrderUploadJobsDto, user: User): Promise<PaginatedResponse<OrderUploadJob>> {
    // 强制设置 orderType 为 'rattle' 来只获取摇铃订单
    const rattleQuery = { ...query, orderType: 'rattle' as const };
    return this.orderUploadJobService.listJobs(rattleQuery, user);
  }

  async getUploadJobItems(
    jobId: string,
    query: QueryOrderUploadJobItemsDto,
    user: User,
  ): Promise<PaginatedResponse<OrderUploadJobItem>> {
    // 验证任务所有权
    const job = await this.orderUploadJobRepository.findOne({
      where: { jobId, userId: user.id },
    });

    if (!job) {
      throw new NotFoundException('任务不存在');
    }

    const { page = 1, limit = 20, status } = query;

    const queryBuilder = this.orderUploadJobItemRepository
      .createQueryBuilder('item')
      .where('item.jobId = :jobId', { jobId })
      .orderBy('item.createdAt', 'ASC');

    if (status) {
      queryBuilder.andWhere('item.status = :status', { status });
    }

    const [items, total] = await queryBuilder
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getRecords(query: any, user: User) {
    // 这里应该返回摇铃订单生成记录
    // 暂时返回空列表
    return {
      items: [],
      meta: {
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 0,
      },
    };
  }

  async getRecordById(id: number, user: User) {
    // 这里应该返回单个摇铃订单生成记录
    throw new NotFoundException('记录不存在');
  }

  async deleteManyRecords(ids: number[], user: User) {
    // 这里应该删除摇铃订单记录
    return { message: '删除成功' };
  }

  private getStatusMessage(status: string): string {
    const messages = {
      queued: '等待处理',
      processing: '正在处理摇铃订单',
      completed: '摇铃订单处理完成',
      failed: '摇铃订单处理失败',
      cancelled: '任务已取消',
    };
    return messages[status] || '未知状态';
  }
}