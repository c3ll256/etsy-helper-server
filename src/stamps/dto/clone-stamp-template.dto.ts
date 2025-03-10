import { IsNumber, IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CloneStampTemplateDto {
  @ApiProperty({ description: '要复制的源模板ID' })
  @IsNumber()
  sourceTemplateId: number;

  @ApiProperty({ description: '新模板的名称（可选，默认为"复制 - 原模板名称"）', required: false })
  @IsString()
  @IsOptional()
  newName?: string;

  @ApiProperty({ description: '新模板的SKU（可选，默认自动生成）', required: false })
  @IsString()
  @IsOptional()
  newSku?: string;
} 