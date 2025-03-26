import { IsString, IsArray, IsOptional, ValidateNested, IsNumber, IsBoolean, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { TextElementDto } from './text-element.dto';

export class GenerateStampDto {
  @ApiProperty({ description: 'Template ID' })
  @IsNumber()
  templateId: number;

  @ApiProperty({ description: 'Text elements with values to replace defaults', type: [TextElementDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TextElementDto)
  textElements: TextElementDto[];

  @ApiProperty({ description: 'Convert text to paths in PNG output', default: false })
  @IsBoolean()
  @IsOptional()
  convertTextToPaths?: boolean = false;
} 