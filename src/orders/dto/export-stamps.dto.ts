import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsEnum } from 'class-validator';

export class ExportStampsDto {
  @ApiProperty({
    description: '开始日期 (YYYY-MM-DD)',
    example: '2024-01-01',
    required: false
  })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiProperty({
    description: '结束日期 (YYYY-MM-DD)',
    example: '2024-12-31',
    required: false
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @ApiProperty({
    description: '搜索订单号',
    required: false
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiProperty({
    description: '按订单状态筛选',
    enum: ['stamp_not_generated', 'stamp_generated_pending_review', 'stamp_generated_reviewed'],
    required: false
  })
  @IsEnum(['stamp_not_generated', 'stamp_generated_pending_review', 'stamp_generated_reviewed'], { 
    message: 'Status must be one of: stamp_not_generated, stamp_generated_pending_review, stamp_generated_reviewed'
  })
  @IsOptional()
  status?: string;
} 