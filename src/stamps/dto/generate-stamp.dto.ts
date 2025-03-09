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
}

class StampTextElementDto {
  @ApiProperty({ description: 'ID of the text element in the template' })
  @IsString()
  id: string;

  @ApiProperty({ description: 'Value to replace the default text' })
  @IsString()
  value: string;

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

  @ApiProperty({ description: 'Output format', default: 'png', enum: ['png', 'jpeg', 'webp'] })
  @IsString()
  @IsOptional()
  format?: 'png' | 'jpeg' | 'webp' = 'png';

  @ApiProperty({ description: 'Output quality (0-1 for jpeg/webp)', default: 0.9 })
  @IsNumber()
  @IsOptional()
  quality?: number = 0.9;
} 