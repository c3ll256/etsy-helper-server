import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

export class SweaterTemplateColumnDto {
  @ApiProperty({ description: '字段 key' })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiProperty({ description: '列标题' })
  @IsString()
  @IsNotEmpty()
  label: string;

  @ApiProperty({ description: '字段描述，用于 AI prompt' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ description: '是否启用' })
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({ description: '列顺序' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  order: number;
}

export class CreateSweaterHeaderTemplateDto {
  @ApiProperty({ description: '模板名称' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: '模板级颜色组 ID 列表', type: [Number], required: false })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  colorGroupIds?: number[];

  @ApiProperty({ description: '列配置', type: [SweaterTemplateColumnDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SweaterTemplateColumnDto)
  columns: SweaterTemplateColumnDto[];

  @ApiProperty({ description: '扩展配置 JSON', required: false, type: Object })
  @IsOptional()
  @IsObject()
  mappingConfigJson?: Record<string, any>;
}

export class UpdateSweaterHeaderTemplateDto extends PartialType(CreateSweaterHeaderTemplateDto) {}

export class QuerySweaterTemplatesDto {
  @ApiProperty({ required: false })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;
}

export class CreateSweaterTransformDto {
  @ApiProperty({ description: '表头模板 ID' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  templateId: number;
}

export class QuerySweaterTransformJobsDto {
  @ApiProperty({ required: false })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;
}
