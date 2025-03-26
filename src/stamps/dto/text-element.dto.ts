import { IsBoolean, IsEnum, IsOptional, ValidateNested } from "class-validator";

import { ApiProperty } from "@nestjs/swagger";
import { IsNumber, IsString } from "class-validator";
import { TextElement } from "../entities/stamp-template.entity";
import { Type } from "class-transformer";

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
  
  @ApiProperty({ description: 'Base angle for circular text', required: false })
  @IsNumber()
  @IsOptional()
  baseAngle?: number;
  
  @ApiProperty({ description: 'Direction for circular text', required: false, enum: ['clockwise', 'counterclockwise'] })
  @IsEnum(['clockwise', 'counterclockwise'])
  @IsOptional()
  direction?: 'clockwise' | 'counterclockwise';

  @ApiProperty({ description: 'Baseline position for circular text', required: false, enum: ['inside', 'outside'] })
  @IsEnum(['inside', 'outside'])  
  @IsOptional()
  baselinePosition?: 'inside' | 'outside';
  
  @ApiProperty({ description: 'Letter spacing for text', required: false })
  @IsNumber()
  @IsOptional()
  letterSpacing?: number;
}

export class TextElementDto implements TextElement {
  @ApiProperty({ description: 'Unique identifier for the text element' })
  @IsString()
  @IsOptional()
  id?: string;

  @ApiProperty({ description: 'Default value for the text element' })
  @IsString()
  @IsOptional()
  defaultValue?: string;

  @ApiProperty({ description: 'Value for the text element' })
  @IsString()
  @IsOptional()
  value?: string;

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
  
  @ApiProperty({ description: 'Description of the text element', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ description: 'Convert text to uppercase automatically', required: false })
  @IsBoolean()
  @IsOptional()
  isUppercase?: boolean;
  
  @ApiProperty({ description: 'Custom padding for text that exceeds canvas boundaries', required: false })
  @IsNumber()
  @IsOptional()
  textPadding?: number;

  @ApiProperty({ description: 'Position and dimensions of the text element' })
  @ValidateNested()
  @Type(() => PositionDto)
  position: PositionDto;
}