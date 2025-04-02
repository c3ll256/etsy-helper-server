import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, IsString, IsEnum, IsDateString, IsUUID, IsArray, IsNumber } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { OrderStatus, StampType } from '../../orders/enums/order.enum';

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
    enum: OrderStatus,
    example: OrderStatus.STAMP_NOT_GENERATED,
  })
  @IsEnum(OrderStatus, { 
    message: '状态必须是有效的订单状态' 
  })
  @IsOptional()
  status?: OrderStatus;

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

  @ApiPropertyOptional({
    description: '用户ID筛选（只有管理员可以使用该筛选）',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsOptional()
  userId?: string;
  
  @ApiPropertyOptional({
    description: '印章模板ID筛选（多选）',
    type: [Number],
    example: [1, 2, 3],
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

  @ApiPropertyOptional({
    description: '印章类型筛选',
    enum: StampType,
    example: StampType.RUBBER,
  })
  @IsEnum(StampType, { 
    message: '印章类型必须是 rubber 或 steel' 
  })
  @IsOptional()
  stampType?: StampType;
} 