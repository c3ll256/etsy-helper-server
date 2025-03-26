import { IsString, IsArray, IsBoolean, IsOptional, ValidateNested, IsNumber, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { TextElementDto } from './text-element.dto';

export class CreateStampTemplateDto {
  @ApiProperty({ description: 'SKU of the stamp template' })
  @IsString()
  sku: string;

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

  @ApiProperty({ description: 'Whether the template is active', default: true, required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
} 