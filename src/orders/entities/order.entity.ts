import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToOne, ManyToOne } from 'typeorm';
import { EtsyOrder } from './etsy-order.entity';
import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/entities/user.entity';
import { OrderStatus, OrderType } from '../enums/order.enum';
import { StampTemplate } from '../../stamps/entities/stamp-template.entity';

@Entity('orders')
export class Order {
  @ApiProperty({
    description: 'The unique identifier of the order',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({
    enum: OrderStatus,
    description: 'The status of the order',
    example: OrderStatus.STAMP_NOT_GENERATED
  })
  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.STAMP_NOT_GENERATED
  })
  status: OrderStatus;

  @ApiProperty({
    enum: OrderType,
    description: 'The type of the order',
    example: OrderType.MANUAL
  })
  @Column({
    type: 'varchar',
    length: 32,
    default: OrderType.MANUAL
  })
  orderType: OrderType;

  @ApiProperty({
    description: 'The order ID from the e-commerce platform',
    example: '1234567890',
    required: false
  })
  @Column({ nullable: true })
  platformOrderId: string;

  @ApiProperty({
    description: 'The creation date of the order from the e-commerce platform',
    example: '2025-02-08',
    required: false
  })
  @Column({ nullable: true, type: 'date' })
  platformOrderDate: Date;

  @ApiProperty({
    description: 'Search key for fuzzy searching, contains concatenated data from various fields',
    example: '1234567890 John Doe Custom Address Stamp',
    required: false
  })
  @Column({ nullable: true, type: 'text' })
  searchKey: string;

  @ApiProperty({
    description: 'The associated Etsy order details',
    type: () => EtsyOrder,
    required: false
  })
  @OneToOne(() => EtsyOrder, (etsyOrder) => etsyOrder.order)
  etsyOrder: EtsyOrder;

  @ApiProperty({
    description: 'The user who owns this order',
    type: () => User,
    required: false
  })
  @ManyToOne(() => User, user => user.orders, { nullable: true })
  user: User;

  @ApiProperty({
    description: 'The user ID who owns this order',
    required: false
  })
  @Column({ nullable: true })
  userId: string;

  @ApiProperty({
    description: 'The creation timestamp',
    example: '2024-02-20T12:00:00Z'
  })
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ApiProperty({
    description: 'The last update timestamp',
    example: '2024-02-20T12:00:00Z'
  })
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @ApiProperty({
    description: 'The order details based on order type',
    nullable: true
  })
  orderDetails?: any;

  @ApiProperty({
    description: 'The template ID for this order',
    example: 1,
    required: false
  })
  @Column({
    nullable: true
  })
  templateId: number;

  @ApiProperty({
    description: 'The stamp template associated with this order',
    type: () => StampTemplate,
    required: false
  })
  @ManyToOne(() => StampTemplate)
  template: StampTemplate;
} 