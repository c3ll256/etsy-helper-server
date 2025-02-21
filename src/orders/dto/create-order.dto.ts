import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateOrderDto {
  @ApiProperty({
    enum: ['pending', 'processing', 'completed', 'cancelled'],
    description: 'Order status',
    example: 'pending'
  })
  @IsEnum(['pending', 'processing', 'completed', 'cancelled'])
  status: string;

  @ApiProperty({
    enum: ['etsy', 'manual', 'other'],
    description: 'Order type',
    example: 'manual'
  })
  @IsEnum(['etsy', 'manual', 'other'])
  orderType: string;
} 