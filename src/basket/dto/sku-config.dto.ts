import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class CreateSkuConfigDto {
  @ApiProperty({ description: '篮子SKU关键词', type: [String], required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  basketSkuKeys?: string[];

  @ApiProperty({ description: '背包SKU关键词', type: [String], required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  backpackSkuKeys?: string[];
}

export class UpdateSkuConfigDto extends CreateSkuConfigDto {}

export class SkuConfigResponseDto {
  @ApiProperty({ description: '配置ID' })
  id: number;

  @ApiProperty({ description: '用户ID' })
  userId: number;

  @ApiProperty({ description: '篮子SKU关键词', type: [String] })
  basketSkuKeys: string[];

  @ApiProperty({ description: '背包SKU关键词', type: [String] })
  backpackSkuKeys: string[];

  @ApiProperty({ description: '创建时间' })
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt: Date;
} 