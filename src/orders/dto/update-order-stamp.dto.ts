import { IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, ValidateNested, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { TextElementDto } from 'src/stamps/dto/text-element.dto';

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