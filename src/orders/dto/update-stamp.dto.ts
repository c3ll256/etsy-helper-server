import { IsArray, IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { TextElementDto } from '../../stamps/dto/text-element.dto';

export class UpdateStampDto {
  @ApiProperty({ description: '模板ID' })
  @IsNumber()
  @IsOptional()
  templateId?: number;

  @ApiProperty({ description: '自定义文本元素', type: [TextElementDto], required: false })
  @IsArray()
  @ValidateNested({ each: true })
  @IsOptional()
  @Type(() => TextElementDto)
  textElements?: TextElementDto[];

  @ApiProperty({ description: '是否转换文本为路径', default: false })
  @IsBoolean()
  @IsOptional()
  convertTextToPaths?: boolean;

  @ApiProperty({ description: '要替换的旧印章记录ID', required: false })
  @IsNumber()
  @IsOptional()
  oldRecordId?: number;
} 