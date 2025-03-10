import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, IsString, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationDto {
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
    description: '订单号搜索',
    example: '1234567890',
  })
  @IsString()
  @IsOptional()
  search?: string;
  
  @ApiPropertyOptional({
    description: '订单状态筛选',
    enum: ['stamp_not_generated', 'stamp_generated_pending_review', 'stamp_generated_reviewed'],
    example: 'stamp_not_generated',
  })
  @IsEnum(['stamp_not_generated', 'stamp_generated_pending_review', 'stamp_generated_reviewed'], { 
    message: '状态必须是有效的订单状态' 
  })
  @IsOptional()
  status?: string;
} 