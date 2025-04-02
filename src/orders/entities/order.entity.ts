import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToOne, ManyToOne } from 'typeorm';
import { EtsyOrder } from './etsy-order.entity';
import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/entities/user.entity';

@Entity('orders')
export class Order {
  @ApiProperty({
    description: 'The unique identifier of the order',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({
    enum: ['stamp_not_generated', 'stamp_generated_pending_review', 'stamp_generated_reviewed'],
    description: 'The status of the order',
    example: 'stamp_not_generated'
  })
  @Column({
    type: 'enum',
    enum: ['stamp_not_generated', 'stamp_generated_pending_review', 'stamp_generated_reviewed'],
    default: 'stamp_not_generated'
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

  @ApiProperty({
    enum: ['rubber', 'steel'],
    description: 'The type of stamp for this order',
    example: 'rubber',
    required: false
  })
  @Column({
    type: 'enum',
    enum: ['rubber', 'steel'],
    nullable: true
  })
  stampType: string;
} 