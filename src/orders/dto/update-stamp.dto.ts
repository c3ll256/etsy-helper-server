import { IsArray, IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

class TextElementDto {
  @ApiProperty({ description: '文本元素ID' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: '文本内容' })
  @IsString()
  @IsNotEmpty()
  value: string;

  @ApiProperty({ description: '字体', required: false })
  @IsString()
  @IsOptional()
  fontFamily?: string;

  @ApiProperty({ description: '字体大小', required: false })
  @IsNumber()
  @IsOptional()
  fontSize?: number;

  @ApiProperty({ description: '字体样式', required: false })
  @IsString()
  @IsOptional()
  fontStyle?: string;

  @ApiProperty({ description: '字体粗细', required: false })
  @IsString()
  @IsOptional()
  fontWeight?: string;

  @ApiProperty({ description: '颜色', required: false })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiProperty({ description: '位置信息', required: false })
  @IsOptional()
  position?: any;
}

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
  customTextElements?: TextElementDto[];

  @ApiProperty({ description: '是否转换文本为路径', default: false })
  @IsBoolean()
  @IsOptional()
  convertTextToPaths?: boolean;
} 