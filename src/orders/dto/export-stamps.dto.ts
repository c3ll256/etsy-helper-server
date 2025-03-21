import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

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
} 