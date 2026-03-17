import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/entities/user.entity';
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type OrderUploadJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type OrderUploadJobType = 'stamp' | 'rattle';

@Entity('order_upload_jobs')
export class OrderUploadJob {
  @ApiProperty({ description: '主键ID', example: 1 })
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @ApiProperty({ description: '任务ID', example: 'job-123' })
  @Column({ name: 'job_id', type: 'varchar', unique: true })
  jobId: string;

  @ApiProperty({ description: '用户ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ApiProperty({ description: '订单类型', example: 'stamp' })
  @Column({ name: 'order_type', type: 'varchar', length: 32, default: 'stamp' })
  orderType: OrderUploadJobType;

  @ApiProperty({ description: '店铺名', required: false })
  @Column({ name: 'shop_name', type: 'varchar', nullable: true })
  shopName: string | null;

  @ApiProperty({ description: '上传文件名' })
  @Column({ name: 'file_name', type: 'varchar' })
  fileName: string;

  @ApiProperty({ description: '任务状态', example: 'processing' })
  @Column({ type: 'varchar', length: 32 })
  status: OrderUploadJobStatus;

  @ApiProperty({ description: '进度百分比', example: 50 })
  @Column({ type: 'numeric', precision: 5, scale: 2, default: 0 })
  progress: number;

  @ApiProperty({ description: '总行数', example: 10 })
  @Column({ name: 'total_rows', type: 'integer', default: 0 })
  totalRows: number;

  @ApiProperty({ description: '成功数', example: 8 })
  @Column({ name: 'success_rows', type: 'integer', default: 0 })
  successRows: number;

  @ApiProperty({ description: '失败数', example: 2 })
  @Column({ name: 'failed_rows', type: 'integer', default: 0 })
  failedRows: number;

  @ApiProperty({ description: '错误信息', required: false })
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @ApiProperty({ description: '报告文件路径', required: false })
  @Column({ name: 'report_path', type: 'varchar', nullable: true })
  reportPath: string | null;

  @ApiProperty({ description: '开始时间', required: false })
  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @ApiProperty({ description: '结束时间', required: false })
  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
