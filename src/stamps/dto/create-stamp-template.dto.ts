import { IsString, IsArray, IsBoolean, IsOptional, ValidateNested, IsNumber, IsEnum, ArrayNotEmpty, ArrayUnique } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { TextElementDto } from './text-element.dto';
import { StampType } from '../entities/stamp-template.entity';

export class CreateStampTemplateDto {
  @ApiProperty({ description: 'SKUs that this template should match', type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  skus: string[];

  @ApiProperty({ description: '是否在 SKU 冲突时自动生成唯一副本 SKU', required: false, default: false })
  @IsBoolean()
  @IsOptional()
  autoResolveSkuConflicts?: boolean;

  @ApiProperty({ description: 'Name of the stamp template' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Path to the background image', required: false })
  @IsString()
  @IsOptional()
  backgroundImagePath?: string;

  @ApiProperty({ description: 'Width of the canvas in pixels', default: 500 })
  @IsNumber()
  @IsOptional()
  width?: number = 500;

  @ApiProperty({ description: 'Height of the canvas in pixels', default: 500 })
  @IsNumber()
  @IsOptional()
  height?: number = 500;

  @ApiProperty({ description: 'Text elements in the stamp template', type: [TextElementDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TextElementDto)
  textElements: TextElementDto[];

  @ApiProperty({ description: 'Description of the stamp template', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  // 分类可在后台自行增删（S4），这里只要求是分类代码字符串，存在性在服务里校验
  @ApiProperty({ description: 'Type (category code) of the stamp', default: StampType.RUBBER, required: false })
  @IsString()
  @IsOptional()
  type?: StampType;

  @ApiProperty({ description: 'Whether the template is active', default: true, required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({ description: '摇铃多模板模式：允许同一 SKU 绑定多个摇铃模板，导入时由人工选择', required: false })
  @IsBoolean()
  @IsOptional()
  allowMultipleForSku?: boolean;
} 
