import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsEnum, IsArray, IsNumber } from 'class-validator';
import { Type, Transform } from 'class-transformer';

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
  
  @ApiProperty({
    description: '印章模板ID筛选（多选）',
    type: [Number],
    example: [1, 2, 3],
    required: false
  })
  @IsArray()
  @IsNumber({}, { each: true })
  @Type(() => Number)
  @Transform(({ value }) => {
    // 处理各种可能的输入格式
    if (value === undefined || value === null) {
      return undefined;
    }
    // 如果已经是数组，直接返回
    if (Array.isArray(value)) {
      return value.map(v => Number(v));
    }
    // 如果是单个值，转换为数组
    return [Number(value)];
  })
  @IsOptional()
  templateIds?: number[];
} 