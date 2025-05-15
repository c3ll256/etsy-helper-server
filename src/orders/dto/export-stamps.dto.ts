import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsEnum, IsArray, IsNumber } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { OrderStatus } from '../enums/order.enum';
import { StampType } from '../../stamps/entities/stamp-template.entity';


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
    enum: OrderStatus,
    required: false
  })
  @IsEnum(OrderStatus, { 
    message: '状态必须是有效的订单状态'
  })
  @IsOptional()
  status?: OrderStatus;
  
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

  @ApiProperty({
    description: '按印章类型筛选',
    enum: StampType,
    required: false
  })
  @IsEnum(StampType, {
    message: '印章类型必须是有效的类型'
  })
  @IsOptional()
  stampType?: StampType;

  @ApiProperty({
    description: '指定要导出的订单ID列表（如果提供，其他筛选条件将被忽略，除了用户权限）',
    type: [String],
    required: false
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  orderIds?: string[];
} 