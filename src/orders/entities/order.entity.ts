import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToOne } from 'typeorm';
import { EtsyOrder } from './etsy-order.entity';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: ['pending', 'processing', 'completed', 'cancelled'],
    default: 'pending'
  })
  status: string;

  @Column({
    type: 'enum',
    enum: ['etsy', 'manual', 'other'],
    default: 'manual'
  })
  orderType: string;

  @OneToOne(() => EtsyOrder, (etsyOrder) => etsyOrder.order)
  etsyOrder: EtsyOrder;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
} 