import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, IsString, IsEnum, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

export class BasketPaginationDto {
  @ApiPropertyOptional({
    description: '页码',
    minimum: 1,
    default: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({
    description: '每页数量',
    minimum: 1,
    default: 10,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  limit?: number = 10;
  
  @ApiPropertyOptional({
    description: '文件名搜索',
    example: '订单表',
  })
  @IsString()
  @IsOptional()
  search?: string;
  
  @ApiPropertyOptional({
    description: '处理状态筛选',
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    example: 'completed',
  })
  @IsEnum(['pending', 'processing', 'completed', 'failed', 'cancelled'], { 
    message: '状态必须是有效的处理状态' 
  })
  @IsOptional()
  status?: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

  @ApiPropertyOptional({
    description: '开始日期筛选 (YYYY-MM-DD)',
    example: '2025-01-01',
  })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    description: '结束日期筛选 (YYYY-MM-DD)',
    example: '2025-12-31',
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;
} 