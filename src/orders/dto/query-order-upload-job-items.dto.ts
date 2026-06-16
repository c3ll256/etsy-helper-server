import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { OrderUploadJobItemStatus } from '../entities/order-upload-job-item.entity';

const ORDER_UPLOAD_JOB_ITEM_STATUS = {
  success: 'success',
  skipped: 'skipped',
  failed: 'failed',
} as const;

export class QueryOrderUploadJobItemsDto {
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

  @ApiPropertyOptional({ enum: ['success', 'skipped', 'failed'] })
  @IsOptional()
  @IsEnum(ORDER_UPLOAD_JOB_ITEM_STATUS)
  status?: OrderUploadJobItemStatus;
}
