import { ApiProperty } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { SweaterHeaderTemplate } from './sweater-header-template.entity';

export type SweaterTransformJobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

@Entity('sweater_transform_jobs')
export class SweaterTransformJob {
  @ApiProperty({ description: '任务 ID' })
  @PrimaryGeneratedColumn()
  id: number;

  @ApiProperty({ description: '用户 ID' })
  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ApiProperty({ description: '模板 ID' })
  @Column({ type: 'bigint', name: 'template_id' })
  templateId: number;

  @ManyToOne(() => SweaterHeaderTemplate, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'template_id' })
  template: SweaterHeaderTemplate;

  @ApiProperty({ description: '队列任务 ID' })
  @Column({ name: 'job_id', unique: true })
  jobId: string;

  @ApiProperty({ description: '输入文件名' })
  @Column({ name: 'input_file_name' })
  inputFileName: string;

  @ApiProperty({ description: '输入文件路径' })
  @Column({ name: 'input_file_path' })
  inputFilePath: string;

  @ApiProperty({ description: '输出文件路径', required: false })
  @Column({ name: 'output_file_path', nullable: true })
  outputFilePath?: string | null;

  @ApiProperty({ description: '状态' })
  @Column({ default: 'pending' })
  status: SweaterTransformJobStatus;

  @ApiProperty({ description: '进度' })
  @Column({ type: 'numeric', precision: 5, scale: 2, default: 0 })
  progress: number;

  @ApiProperty({ description: '错误信息', required: false })
  @Column({ type: 'text', name: 'error_message', nullable: true })
  errorMessage?: string | null;

  @ApiProperty({ description: '输入行数', required: false })
  @Column({ type: 'int', name: 'total_rows', default: 0 })
  totalRows: number;

  @ApiProperty({ description: '输出行数', required: false })
  @Column({ type: 'int', name: 'output_rows', default: 0 })
  outputRows: number;

  @ApiProperty({ description: '开始时间', required: false })
  @Column({ type: 'timestamptz', name: 'started_at', nullable: true })
  startedAt?: Date | null;

  @ApiProperty({ description: '结束时间', required: false })
  @Column({ type: 'timestamptz', name: 'finished_at', nullable: true })
  finishedAt?: Date | null;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
