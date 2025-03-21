import { IsArray, IsNumber, IsOptional, IsString, ValidateNested, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

class TextPositionDto {
  @ApiProperty({ description: 'X coordinate of the text element' })
  @IsNumber()
  @IsOptional()
  x?: number;

  @ApiProperty({ description: 'Y coordinate of the text element' })
  @IsNumber()
  @IsOptional()
  y?: number;

  @ApiProperty({ description: 'Width of the text element', required: false })
  @IsNumber()
  @IsOptional()
  width?: number;

  @ApiProperty({ description: 'Height of the text element', required: false })
  @IsNumber()
  @IsOptional()
  height?: number;

  @ApiProperty({ description: 'Rotation angle in degrees', required: false })
  @IsNumber()
  @IsOptional()
  rotation?: number;
  
  @ApiProperty({ description: 'Text alignment (left, center, right)', required: false })
  @IsString()
  @IsOptional()
  textAlign?: string;
}

class PreviewTextElementDto {
  @ApiProperty({ description: 'ID of the text element' })
  @IsString()
  id: string;

  @ApiProperty({ description: 'Text value' })
  @IsString()
  value: string;

  @ApiProperty({ description: 'Font family', required: false })
  @IsString()
  @IsOptional()
  fontFamily?: string;

  @ApiProperty({ description: 'Font size', required: false })
  @IsNumber()
  @IsOptional()
  fontSize?: number;

  @ApiProperty({ description: 'Font weight', required: false })
  @IsString()
  @IsOptional()
  fontWeight?: string;

  @ApiProperty({ description: 'Font style', required: false })
  @IsString()
  @IsOptional()
  fontStyle?: string;

  @ApiProperty({ description: 'Text color', required: false })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiProperty({ description: 'Position and dimensions of the text element', required: false })
  @ValidateNested()
  @Type(() => TextPositionDto)
  @IsOptional()
  position?: TextPositionDto;
}

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

  @ApiProperty({ description: 'Text elements with values and styling', type: [PreviewTextElementDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreviewTextElementDto)
  textElements: PreviewTextElementDto[];

  @ApiProperty({ description: 'Convert text to paths in SVG output', default: false })
  @IsBoolean()
  @IsOptional()
  convertTextToPaths?: boolean = false;
} 