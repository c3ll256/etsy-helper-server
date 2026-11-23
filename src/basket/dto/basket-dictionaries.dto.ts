import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

export class DictionaryPaginationDto {
  @ApiProperty({ required: false, default: 1 })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number = 20;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;
}

export const BASKET_PRODUCT_TYPES = ['maternal_baby', 'sweater'] as const;

export class QueryColorGroupsDto extends DictionaryPaginationDto {
  @ApiProperty({ required: false, enum: BASKET_PRODUCT_TYPES })
  @IsOptional()
  @IsString()
  @IsIn(BASKET_PRODUCT_TYPES)
  productType?: string;
}

export class CreateColorGroupDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: BASKET_PRODUCT_TYPES })
  @IsString()
  @IsIn(BASKET_PRODUCT_TYPES)
  productType: string;
}

export class UpdateColorGroupDto extends PartialType(CreateColorGroupDto) {}

export class QueryColorKvDto extends DictionaryPaginationDto {
  @ApiProperty({ required: false })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  groupId?: number | null;
}

export class CreateColorKvDto {
  @ApiProperty({ required: false, nullable: true })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  groupId?: number | null;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  colorValue: string;

  @ApiProperty({ required: false, nullable: true, type: [String], description: '混色毛线颜色顺序（用于混色名字 + 毛线图标自动算色与撞色跳色）' })
  @IsOptional()
  colorSequence?: string[] | string | null;
}

export class UpdateColorKvDto extends PartialType(CreateColorKvDto) {}

export class CreateColorKvBatchItemDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  colorValue: string;

  @ApiProperty({ required: false, nullable: true, type: [String] })
  @IsOptional()
  colorSequence?: string[] | string | null;
}

export class CreateColorKvBatchDto {
  @ApiProperty({ nullable: true })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  groupId?: number | null;

  @ApiProperty({ type: [CreateColorKvBatchItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateColorKvBatchItemDto)
  items: CreateColorKvBatchItemDto[];
}

export class DeleteColorKvBatchDto {
  @ApiProperty({ type: [Number] })
  @IsArray()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  ids: number[];
}

export class QueryIconGroupsDto extends DictionaryPaginationDto {
  @ApiProperty({ required: false, enum: BASKET_PRODUCT_TYPES })
  @IsOptional()
  @IsString()
  @IsIn(BASKET_PRODUCT_TYPES)
  productType?: string;
}

export class CreateIconGroupDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: BASKET_PRODUCT_TYPES })
  @IsString()
  @IsIn(BASKET_PRODUCT_TYPES)
  productType: string;
}

export class UpdateIconGroupDto extends PartialType(CreateIconGroupDto) {}

export class QueryIconKvDto extends DictionaryPaginationDto {
  @ApiProperty({ required: false })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  groupId?: number;
}

export class CreateIconKvDto {
  @ApiProperty({ required: false, nullable: true })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  groupId?: number | null;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ required: false, description: '完整编号' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({ required: false, description: '本店别名，逗号分隔或数组' })
  @IsOptional()
  aliases?: string[] | string;

  @ApiProperty({ required: false, enum: ['large', 'flower', 'yarn', 'bow'] })
  @IsOptional()
  @IsIn(['large', 'flower', 'yarn', 'bow'])
  kind?: string;
}

export class DeleteIconKvBatchDto {
  @ApiProperty({ type: [Number] })
  @IsArray()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  ids: number[];
}

export class UpdateIconKvDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, nullable: true, description: '完整编号' })
  @IsOptional()
  code?: string | null;

  @ApiProperty({ required: false, description: '本店别名，逗号分隔或数组' })
  @IsOptional()
  aliases?: string[] | string | null;

  @ApiProperty({ required: false, enum: ['large', 'flower', 'yarn', 'bow'] })
  @IsOptional()
  @IsIn(['large', 'flower', 'yarn', 'bow'])
  kind?: string;

  @ApiProperty({ required: false, nullable: true })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  groupId?: number | null;
}
