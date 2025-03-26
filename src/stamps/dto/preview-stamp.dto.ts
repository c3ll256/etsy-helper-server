import { IsArray, IsNumber, IsOptional, IsString, ValidateNested, IsBoolean, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { TextElementDto } from './text-element.dto';

export class PreviewStampDto {
  @ApiProperty({ description: 'Template ID (optional if creating a new template)', required: false })
  @IsNumber()
  @IsOptional()
  templateId?: number;

  @ApiProperty({ description: 'Width of the canvas in pixels', default: 500 })
  @IsNumber()
  @IsOptional()
  width?: number = 500;

  @ApiProperty({ description: 'Height of the canvas in pixels', default: 500 })
  @IsNumber()
  @IsOptional()
  height?: number = 500;

  @ApiProperty({ description: 'Path to the background image', required: false })
  @IsString()
  @IsOptional()
  backgroundImagePath?: string;

  @ApiProperty({ description: 'Text elements with values and styling', type: [TextElementDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TextElementDto)
  textElements: TextElementDto[];

  @ApiProperty({ description: 'Convert text to paths in PNG output', default: false })
  @IsBoolean()
  @IsOptional()
  convertTextToPaths?: boolean = false;
} 