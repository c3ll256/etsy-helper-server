import { Entity, Column, CreateDateColumn, UpdateDateColumn, OneToOne, JoinColumn, PrimaryGeneratedColumn } from 'typeorm';
import { Order } from './order.entity';
import { ApiProperty } from '@nestjs/swagger';

@Entity('etsy_orders')
export class EtsyOrder {
  @ApiProperty({ description: '唯一ID', example: 1 })
  @PrimaryGeneratedColumn()
  id: number;

  @ApiProperty({ description: 'Etsy order ID', example: '1234567890' })
  @Column('varchar')
  orderId: string;

  @ApiProperty({ description: 'Etsy transaction ID', example: '9876543210', required: false })
  @Column('varchar', { nullable: true })
  transactionId: string;

  @ApiProperty({ description: 'Etsy listing ID', example: '1122334455', required: false })
  @Column('varchar', { nullable: true })
  listingId: string;

  @ApiProperty({ description: 'Item name', example: 'Custom Address Stamp', required: false })
  @Column({ nullable: true })
  itemName: string;

  @ApiProperty({ description: 'Buyer information', example: 'John Doe (johndoe)', required: false })
  @Column({ nullable: true })
  buyer: string;

  @ApiProperty({ description: 'Quantity ordered', example: 1, required: false })
  @Column({ nullable: true })
  quantity: number;

  @ApiProperty({ description: 'Item price', example: 29.99, required: false })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  price: number;

  @ApiProperty({ description: 'Coupon code used', example: 'SAVE20', required: false })
  @Column({ nullable: true })
  couponCode: string;

  @ApiProperty({ description: 'Coupon details', example: 'SAVE20 - 20% off', required: false })
  @Column({ nullable: true })
  couponDetails: string;

  @ApiProperty({ description: 'Discount amount', example: 5.99, required: false })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  discountAmount: number;

  @ApiProperty({ description: 'Shipping discount', example: 0, required: false })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  shippingDiscount: number;

  @ApiProperty({ description: 'Shipping cost', example: 3.99, required: false })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  orderShipping: number;

  @ApiProperty({ description: 'Sales tax', example: 2.50, required: false })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  orderSalesTax: number;

  @ApiProperty({ description: 'Total item cost', example: 35.99, required: false })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  itemTotal: number;

  @ApiProperty({ description: 'Currency', example: 'USD', required: false })
  @Column({ nullable: true })
  currency: string;

  @ApiProperty({ description: 'Date paid', example: '2024-02-20', required: false })
  @Column({ type: 'date', nullable: true })
  datePaid: Date;

  @ApiProperty({ description: 'Shipping name', example: 'John Doe', required: false })
  @Column({ nullable: true })
  shipName: string;

  @ApiProperty({ description: 'Shipping address', example: '123 Main St', required: false })
  @Column({ nullable: true })
  shipAddress1: string;

  @ApiProperty({ description: 'Shipping city', example: 'New York', required: false })
  @Column({ nullable: true })
  shipCity: string;

  @ApiProperty({ description: 'Shipping state', example: 'NY', required: false })
  @Column({ nullable: true })
  shipState: string;

  @ApiProperty({ description: 'Shipping zip code', example: '10001', required: false })
  @Column('varchar', { nullable: true })
  shipZipcode: string;

  @ApiProperty({ description: 'Shipping country', example: 'United States', required: false })
  @Column({ nullable: true })
  shipCountry: string;

  @ApiProperty({
    description: 'Order variations',
    example: { 'Color': 'Red', 'Size': 'Large' },
    required: false
  })
  @Column({ type: 'jsonb', nullable: true })
  variations: any;

  @ApiProperty({
    description: 'Original variations string before parsing',
    example: 'Color:Red,Size:Large',
    required: false
  })
  @Column({ nullable: true })
  originalVariations: string;

  @ApiProperty({ description: 'Order type', example: 'online', required: false })
  @Column({ nullable: true })
  orderType: string;

  @ApiProperty({ description: 'Listing type', example: 'listing', required: false })
  @Column({ nullable: true })
  listingsType: string;

  @ApiProperty({ description: 'Payment type', example: 'online_cc', required: false })
  @Column({ nullable: true })
  paymentType: string;

  @ApiProperty({ description: 'VAT paid by buyer', example: 0, required: false })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  vatPaidByBuyer: number;

  @ApiProperty({ description: 'SKU', example: 'STAMP-001', required: false })
  @Column({ nullable: true })
  sku: string;

  @ApiProperty({ description: 'Sale date', example: '2024-02-20', required: false })
  @Column({ type: 'date', nullable: true })
  saleDate: Date;

  @ApiProperty({ description: 'Associated order', type: () => Order })
  @OneToOne(() => Order, { nullable: true })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @ApiProperty({ description: 'Creation timestamp' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  @UpdateDateColumn()
  updatedAt: Date;

  @ApiProperty({ description: '印章图片URL' })
  @Column({ nullable: true })
  stampImageUrl: string;

  @ApiProperty({ 
    description: '印章生成记录ID数组，用于存储多个印章生成记录',
    type: 'array',
    items: { type: 'number' },
    required: false
  })
  @Column('jsonb', { nullable: true, default: [] })
  stampGenerationRecordIds: number[];
} 