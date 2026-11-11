import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional, IsNumber, IsObject, IsArray, IsBoolean, ValidateNested, IsInt, Min, IsIn } from 'class-validator';
import { SkuType } from '../entities/sku-config.entity';
import { Type } from 'class-transformer';

export class ComboOverrideDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  iconLayoutTemplateId?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  maxIcons?: number;

  @ApiProperty({ required: false, type: Object })
  @IsOptional()
  @IsObject()
  nameLayout?: Record<string, any>;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  fontSize?: number;

  @ApiProperty({ required: false })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  colorGroupId?: number;

  @ApiProperty({ required: false })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  iconGroupId?: number;
}

export class CreateSkuConfigDto {
  @ApiProperty({ description: 'SKU编码' })
  @IsString()
  sku: string;

  @ApiProperty({ description: 'SKU类型：母婴、毛衣或套组', enum: SkuType })
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
  @ApiProperty({ description: '套组款式数组，例如 ["SKU1", "SKU2"]', required: false, type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  comboItems?: string[];

  @ApiProperty({ description: '颜色组ID', required: false })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  colorGroupId?: number;

  @ApiProperty({ description: '图标组ID', required: false })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  iconGroupId?: number;

  @ApiProperty({ description: '套组子 SKU 覆盖配置', required: false, type: Object })
  @IsObject()
  @IsOptional()
  comboOverridesJson?: Record<string, ComboOverrideDto>;

  @ApiProperty({ description: '外部订单提醒开关', required: false })
  @IsBoolean()
  @IsOptional()
  externalOrderReminderEnabled?: boolean;

  @ApiProperty({ description: '外部订单提醒内容', required: false })
  @IsString()
  @IsOptional()
  externalOrderReminderContent?: string;

  @ApiProperty({ description: '生成方式：ppt / external（正常连单，不做 PPT）/ ignore（非商品行）', required: false })
  @IsOptional()
  @IsIn(['ppt', 'external', 'ignore'])
  produceMode?: 'ppt' | 'external' | 'ignore';

  @ApiProperty({ description: '图标布局模板ID', required: false, nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  iconLayoutTemplateId?: number | null;

  @ApiProperty({ description: '每件最多图标数，空为不限', required: false, nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxIcons?: number | null;

  @ApiProperty({ description: '名字安全区和字号', required: false, nullable: true, type: Object })
  @IsOptional()
  @IsObject()
  nameLayout?: Record<string, any> | null;

  @ApiProperty({ description: '母体（参考图共用分组）', required: false, nullable: true })
  @IsOptional()
  @IsString()
  referenceGroupKey?: string | null;
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

/** 批量设置：对勾选的多个 SKU 只改 patch 里给出的字段（例如同一母体下的所有子 SKU） */
export class BatchApplySkuConfigDto {
  @ApiProperty({ description: '要修改的 SKU 配置 id', type: [Number] })
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  ids: number[];

  @ApiProperty({ description: '要改的字段：font, fontSize, colorGroupId, iconGroupId, produceMode, iconLayoutTemplateId, maxIcons, nameLayout, referenceGroupKey' })
  @IsObject()
  patch: Record<string, any>;
}
