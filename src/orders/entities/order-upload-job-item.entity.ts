import { ApiProperty } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type OrderUploadJobItemStatus = 'success' | 'skipped' | 'failed';

@Entity('order_upload_job_items')
export class OrderUploadJobItem {
  @ApiProperty({ description: '主键ID', example: 1 })
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @ApiProperty({ description: '任务ID', example: 'job-123' })
  @Column({ name: 'job_id', type: 'varchar' })
  jobId: string;

  @ApiProperty({ description: '订单号', required: false })
  @Column({ name: 'order_id', type: 'varchar', nullable: true })
  orderId: string | null;

  @ApiProperty({ description: '交易号', required: false })
  @Column({ name: 'transaction_id', type: 'varchar', nullable: true })
  transactionId: string | null;

  @ApiProperty({ description: 'SKU', required: false })
  @Column({ type: 'varchar', nullable: true })
  sku: string | null;

  @ApiProperty({ description: '处理状态', example: 'failed' })
  @Column({ type: 'varchar', length: 32 })
  status: OrderUploadJobItemStatus;

  @ApiProperty({ description: '原因', required: false })
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @ApiProperty({ description: '扩展明细', required: false })
  @Column({ name: 'detail_json', type: 'jsonb', nullable: true })
  detailJson: Record<string, any> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
