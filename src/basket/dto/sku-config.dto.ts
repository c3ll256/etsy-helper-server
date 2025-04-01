import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional, IsNumber, Min, Max } from 'class-validator';
import { SkuType } from '../entities/sku-config.entity';

export class CreateSkuConfigDto {
  @ApiProperty({ description: 'SKU编码' })
  @IsString()
  sku: string;

  @ApiProperty({ description: 'SKU类型：篮子或书包', enum: SkuType })
  @IsEnum(SkuType)
  type: SkuType;

  @ApiProperty({ description: '替换后的显示文本', required: false })
  @IsString()
  @IsOptional()
  replaceValue?: string;

  @ApiProperty({ description: '字体大小', required: false })
  @IsNumber()
  @IsOptional()
  fontSize?: number;

  @ApiProperty({ description: '字体名称', required: false })
  @IsString()
  @IsOptional()
  font?: string;
}

export class SkuConfigResponseDto extends CreateSkuConfigDto {
  @ApiProperty({ description: '配置ID' })
  id: number;

  @ApiProperty({ description: '用户ID' })
  userId: string;

  @ApiProperty({ description: '创建时间' })
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt: Date;
} 