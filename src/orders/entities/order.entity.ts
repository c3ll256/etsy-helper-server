import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToOne } from 'typeorm';
import { EtsyOrder } from './etsy-order.entity';
import { ApiProperty } from '@nestjs/swagger';

@Entity('orders')
export class Order {
  @ApiProperty({
    description: 'The unique identifier of the order',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({
    enum: ['pending', 'processing', 'completed', 'cancelled'],
    description: 'The status of the order',
    example: 'pending'
  })
  @Column({
    type: 'enum',
    enum: ['pending', 'processing', 'completed', 'cancelled'],
    default: 'pending'
  })
  status: string;

  @ApiProperty({
    enum: ['etsy', 'manual', 'other'],
    description: 'The type of the order',
    example: 'manual'
  })
  @Column({
    type: 'enum',
    enum: ['etsy', 'manual', 'other'],
    default: 'manual'
  })
  orderType: string;

  @ApiProperty({
    description: 'The associated Etsy order details',
    type: () => EtsyOrder,
    required: false
  })
  @OneToOne(() => EtsyOrder, (etsyOrder) => etsyOrder.order)
  etsyOrder: EtsyOrder;

  @ApiProperty({
    description: 'The creation timestamp',
    example: '2024-02-20T12:00:00Z'
  })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({
    description: 'The last update timestamp',
    example: '2024-02-20T12:00:00Z'
  })
  @UpdateDateColumn()
  updatedAt: Date;

  @ApiProperty({
    description: 'The order details based on order type',
    nullable: true
  })
  orderDetails?: any;
} 