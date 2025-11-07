import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional, IsNumber, IsObject, IsArray, ValidateNested, IsBoolean } from 'class-validator';
import { SkuType } from '../entities/sku-config.entity';
import { Type } from 'class-transformer';

export class ComboItemDto {
  @ApiProperty({ description: '款式 SKU' })
  @IsString()
  sku: string;

  @ApiProperty({ description: '颜色配置' })
  @IsString()
  color: string;
}

export class CreateSkuConfigDto {
  @ApiProperty({ description: 'SKU编码' })
  @IsString()
  sku: string;

  @ApiProperty({ description: 'SKU类型：篮子、书包或套组', enum: SkuType })
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

  @ApiProperty({ description: 'Yarn 颜色替换映射(JSON 对象)。例如 {"Cream": "奶油色"}', required: false, type: Object })
  @IsObject()
  @IsOptional()
  yarnColorMap?: Record<string, string>;

  // 套组配置（当 type = combo 时生效）
  @ApiProperty({ description: '套组款式数组', required: false, type: [ComboItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComboItemDto)
  @IsOptional()
  comboItems?: ComboItemDto[];

  @ApiProperty({ description: '外部订单提醒开关', required: false })
  @IsBoolean()
  @IsOptional()
  externalOrderReminderEnabled?: boolean;

  @ApiProperty({ description: '外部订单提醒内容', required: false })
  @IsString()
  @IsOptional()
  externalOrderReminderContent?: string;
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

export class BatchUpdateSkuConfigItemDto extends PartialType(CreateSkuConfigDto) {
  @ApiProperty({ description: '配置ID（必需）' })
  @IsNumber()
  id: number;
}

export class BatchUpdateSkuConfigDto {
  @ApiProperty({ description: '要更新的配置列表', type: [BatchUpdateSkuConfigItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchUpdateSkuConfigItemDto)
  configs: BatchUpdateSkuConfigItemDto[];
}
