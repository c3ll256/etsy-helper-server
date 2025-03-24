import { IsString, IsArray, IsBoolean, IsOptional, ValidateNested, IsNumber, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { TextElement } from '../entities/stamp-template.entity';

class PositionDto {
  @ApiProperty({ description: 'X coordinate of the text element' })
  @IsNumber()
  x: number;

  @ApiProperty({ description: 'Y coordinate of the text element' })
  @IsNumber()
  y: number;

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
  
  @ApiProperty({ description: 'Vertical alignment', required: false, enum: ['top', 'middle', 'baseline'] })
  @IsString()
  @IsOptional()
  verticalAlign?: 'top' | 'middle' | 'baseline';
  
  @ApiProperty({ description: 'Whether the text should be rendered in a circular path', required: false })
  @IsBoolean()
  @IsOptional()
  isCircular?: boolean;
  
  @ApiProperty({ description: 'Radius of the circular text path', required: false })
  @IsNumber()
  @IsOptional()
  radius?: number;
  
  @ApiProperty({ description: 'Start angle for circular text (in degrees)', required: false })
  @IsNumber()
  @IsOptional()
  startAngle?: number;
  
  @ApiProperty({ description: 'End angle for circular text (in degrees)', required: false })
  @IsNumber()
  @IsOptional()
  endAngle?: number;
  
  @ApiProperty({ description: 'Direction for circular text', required: false, enum: ['clockwise', 'counterclockwise'] })
  @IsEnum(['clockwise', 'counterclockwise'])
  @IsOptional()
  direction?: 'clockwise' | 'counterclockwise';
}

class TextElementDto implements TextElement {
  @ApiProperty({ description: 'Unique identifier for the text element' })
  @IsString()
  id: string;

  @ApiProperty({ description: 'Default value for the text element' })
  @IsString()
  defaultValue: string;

  @ApiProperty({ description: 'Font family for the text element' })
  @IsString()
  fontFamily: string;

  @ApiProperty({ description: 'Font size for the text element' })
  @IsNumber()
  fontSize: number;

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

  @ApiProperty({ description: 'Position and dimensions of the text element' })
  @ValidateNested()
  @Type(() => PositionDto)
  position: PositionDto;
}

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