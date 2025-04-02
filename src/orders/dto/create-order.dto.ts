import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus, OrderType } from '../enums/order.enum';

export class CreateOrderDto {
  @ApiProperty({
    enum: OrderStatus,
    description: 'Order status',
    example: OrderStatus.STAMP_NOT_GENERATED
  })
  @IsEnum(OrderStatus)
  status: OrderStatus;

  @ApiProperty({
    enum: OrderType,
    description: 'Order type',
    example: OrderType.MANUAL
  })
  @IsEnum(OrderType)
  orderType: OrderType;
} 