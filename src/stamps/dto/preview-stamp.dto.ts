import { IsString, IsArray, IsOptional, ValidateNested, IsNumber } from 'class-validator';
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

  @ApiProperty({ description: 'Text alignment', required: false, enum: ['left', 'center', 'right'] })
  @IsString()
  @IsOptional()
  textAlign?: 'left' | 'center' | 'right';
}

class PreviewTextElementDto {
  @ApiProperty({ description: 'Unique identifier for the text element' })
  @IsString()
  id: string;

  @ApiProperty({ description: 'Value for the text element' })
  @IsString()
  value: string;

  @ApiProperty({ description: 'Font family for the text element' })
  @IsString()
  @IsOptional()
  fontFamily?: string;

  @ApiProperty({ description: 'Font size for the text element' })
  @IsNumber()
  @IsOptional()
  fontSize?: number;

  @ApiProperty({ description: 'Font weight for the text element', required: false })
  @IsString()
  @IsOptional()
  fontWeight?: string;

  @ApiProperty({ description: 'Font style for the text element', required: false })
  @IsString()
  @IsOptional()
  fontStyle?: string;

  @ApiProperty({ description: 'Text color in hex format', required: false })
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

  @ApiProperty({ description: 'Output format', default: 'png', enum: ['png', 'jpeg', 'webp'] })
  @IsString()
  @IsOptional()
  format?: 'png' | 'jpeg' | 'webp' = 'png';

  @ApiProperty({ description: 'Output quality (0-1 for jpeg/webp)', default: 0.9 })
  @IsNumber()
  @IsOptional()
  quality?: number = 0.9;
} 