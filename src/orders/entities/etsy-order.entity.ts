import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToOne, JoinColumn } from 'typeorm';
import { Order } from './order.entity';

@Entity('etsy_orders')
export class EtsyOrder {
  @PrimaryColumn('varchar')
  orderId: string;

  @Column('varchar', { nullable: true })
  transactionId: string;

  @Column('varchar', { nullable: true })
  listingId: string;

  @Column({ nullable: true })
  itemName: string;

  @Column({ nullable: true })
  buyer: string;

  @Column({ nullable: true })
  quantity: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  price: number;

  @Column({ nullable: true })
  couponCode: string;

  @Column({ nullable: true })
  couponDetails: string;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  discountAmount: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  shippingDiscount: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  orderShipping: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  orderSalesTax: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  itemTotal: number;

  @Column({ nullable: true })
  currency: string;

  @Column({ type: 'date', nullable: true })
  datePaid: Date;

  @Column({ nullable: true })
  shipName: string;

  @Column({ nullable: true })
  shipAddress1: string;

  @Column({ nullable: true })
  shipCity: string;

  @Column({ nullable: true })
  shipState: string;

  @Column('varchar', { nullable: true })
  shipZipcode: string;

  @Column({ nullable: true })
  shipCountry: string;

  @Column({ type: 'jsonb', nullable: true })
  variations: any;

  @Column({ nullable: true })
  orderType: string;

  @Column({ nullable: true })
  listingsType: string;

  @Column({ nullable: true })
  paymentType: string;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  vatPaidByBuyer: number;

  @Column({ nullable: true })
  sku: string;

  @Column({ type: 'date', nullable: true })
  saleDate: Date;

  @OneToOne(() => Order, { nullable: true })
  @JoinColumn()
  order: Order;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
} 