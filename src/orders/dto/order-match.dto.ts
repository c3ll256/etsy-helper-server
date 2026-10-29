import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString } from 'class-validator';

export class ReprocessOrdersDto {
  @ApiProperty({ description: '订单 ID（UUID）列表', type: [String] })
  @IsArray()
  @IsString({ each: true })
  orderIds: string[];

  @ApiProperty({ description: 'rematch：按规则重新匹配模板并更新设计；regenerate：按当前模板重新解析和生成', enum: ['rematch', 'regenerate'] })
  @IsIn(['rematch', 'regenerate'])
  mode: 'rematch' | 'regenerate';

  @ApiPropertyOptional({ description: '确认覆盖已审核 / 已人工调整的设计（覆盖前会备份）' })
  @IsOptional()
  @IsBoolean()
  confirmOverwrite?: boolean;

  @ApiPropertyOptional({ description: '只预览影响，不修改数据' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class AssignTemplateDto {
  @ApiProperty({ description: '模板 ID' })
  @IsInt()
  templateId: number;

  @ApiProperty({ description: 'order：仅修改当前订单；sku：同时更新该 SKU 后续订单的关联', enum: ['order', 'sku'] })
  @IsIn(['order', 'sku'])
  scope: 'order' | 'sku';

  @ApiPropertyOptional({ description: '确认覆盖已审核 / 已人工调整的设计' })
  @IsOptional()
  @IsBoolean()
  confirmOverwrite?: boolean;
}

export class MatchAuditDto {
  @ApiPropertyOptional({ description: '重算除手动指定以外的全部订单（默认只处理还没有匹配状态的历史订单）' })
  @IsOptional()
  @IsBoolean()
  overwrite?: boolean;

  @ApiPropertyOptional({ description: '只统计，不写入' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class BuyerNoteDto {
  @ApiProperty({ description: '备注原文（保留换行）；空字符串表示清除' })
  @IsString()
  note: string;
}

export class DryRunDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
