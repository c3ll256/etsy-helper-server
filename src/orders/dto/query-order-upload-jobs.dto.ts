import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { OrderUploadJobStatus, OrderUploadJobType } from '../entities/order-upload-job.entity';

const ORDER_UPLOAD_JOB_STATUS = {
  queued: 'queued',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

const ORDER_UPLOAD_JOB_TYPE = {
  stamp: 'stamp',
  rattle: 'rattle',
} as const;

export class QueryOrderUploadJobsDto {
  @ApiPropertyOptional({ description: '页码', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页数量', default: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  limit?: number = 10;

  @ApiPropertyOptional({ enum: ['queued', 'processing', 'completed', 'failed', 'cancelled'] })
  @IsOptional()
  @IsEnum(ORDER_UPLOAD_JOB_STATUS)
  status?: OrderUploadJobStatus;

  @ApiPropertyOptional({ enum: ['stamp', 'rattle'], description: '订单类型' })
  @IsOptional()
  @IsEnum(ORDER_UPLOAD_JOB_TYPE)
  orderType?: OrderUploadJobType;

  @ApiPropertyOptional({ description: '开始日期 (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: '结束日期 (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ description: '管理员筛选用户ID' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}
