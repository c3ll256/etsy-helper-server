import { IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, ValidateNested, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

class PositionDto {
  @ApiProperty({ description: 'X坐标' })
  @IsNumber()
  x: number;

  @ApiProperty({ description: 'Y坐标' })
  @IsNumber()
  y: number;

  @ApiProperty({ description: '宽度', required: false })
  @IsNumber()
  @IsOptional()
  width?: number;

  @ApiProperty({ description: '高度', required: false })
  @IsNumber()
  @IsOptional()
  height?: number;

  @ApiProperty({ description: '旋转角度', required: false })
  @IsNumber()
  @IsOptional()
  rotation?: number;

  @ApiProperty({ description: '文本对齐方式', enum: ['left', 'center', 'right'], required: false })
  @IsEnum(['left', 'center', 'right'])
  @IsOptional()
  textAlign?: 'left' | 'center' | 'right';
}

class TextElementDto {
  @ApiProperty({ description: '文本元素ID' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: '文本内容' })
  @IsString()
  value: string;

  @ApiProperty({ description: '字体', required: false })
  @IsString()
  @IsOptional()
  fontFamily?: string;

  @ApiProperty({ description: '字体大小', required: false })
  @IsNumber()
  @IsOptional()
  fontSize?: number;

  @ApiProperty({ description: '字体样式 (normal, italic)', required: false })
  @IsString()
  @IsOptional()
  fontStyle?: string;

  @ApiProperty({ description: '字体粗细 (normal, bold)', required: false })
  @IsString()
  @IsOptional()
  fontWeight?: string;

  @ApiProperty({ description: '文本颜色', required: false })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiProperty({ description: '位置和布局信息', type: PositionDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => PositionDto)
  position?: PositionDto;
}

export class UpdateOrderStampDto {
  @ApiProperty({ description: '订单ID' })
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @ApiProperty({ description: '印章模板ID' })
  @IsNumber()
  templateId: number;

  @ApiProperty({ description: '文本元素列表', type: [TextElementDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TextElementDto)
  textElements: TextElementDto[];
} 