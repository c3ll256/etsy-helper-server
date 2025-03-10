import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateOrderDto {
  @ApiProperty({
    enum: ['stamp_not_generated', 'stamp_generated_pending_review', 'stamp_generated_reviewed'],
    description: 'Order status',
    example: 'stamp_not_generated'
  })
  @IsEnum(['stamp_not_generated', 'stamp_generated_pending_review', 'stamp_generated_reviewed'])
  status: string;

  @ApiProperty({
    enum: ['etsy', 'manual', 'other'],
    description: 'Order type',
    example: 'manual'
  })
  @IsEnum(['etsy', 'manual', 'other'])
  orderType: string;
} 