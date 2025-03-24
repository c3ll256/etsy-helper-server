import { IsString, IsArray, IsOptional, ValidateNested, IsNumber, IsBoolean, IsEnum } from 'class-validator';
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
  
  @ApiProperty({ description: 'Vertical alignment (top, middle, baseline)', required: false })
  @IsString()
  @IsOptional()
  verticalAlign?: string;
  
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

class StampTextElementDto {
  @ApiProperty({ description: 'ID of the text element in the template' })
  @IsString()
  id: string;

  @ApiProperty({ description: 'Value to replace the default text' })
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

  @ApiProperty({ description: 'Optional position override', required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => TextPositionDto)
  position?: TextPositionDto;
}

export class GenerateStampDto {
  @ApiProperty({ description: 'Template ID' })
  @IsNumber()
  templateId: number;

  @ApiProperty({ description: 'Text elements with values to replace defaults', type: [StampTextElementDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StampTextElementDto)
  textElements: StampTextElementDto[];

  @ApiProperty({ description: 'Convert text to paths in SVG output', default: false })
  @IsBoolean()
  @IsOptional()
  convertTextToPaths?: boolean = false;
} 