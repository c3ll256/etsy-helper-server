import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/entities/user.entity';

@Entity('basket_generation_records')
export class BasketGenerationRecord {
  @ApiProperty({ description: '记录ID' })
  @PrimaryGeneratedColumn()
  id: number;

  @ApiProperty({ description: '原始Excel文件名' })
  @Column()
  originalFilename: string;

  @ApiProperty({ description: '处理状态', enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'] })
  @Column({ default: 'pending' })
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

  @ApiProperty({ description: '处理进度 (0-100)' })
  @Column({ type: 'float', default: 0 })
  progress: number;

  @ApiProperty({ description: '生成的PPT文件路径' })
  @Column({ nullable: true })
  outputFilePath: string;

  @ApiProperty({ description: '任务队列ID', required: false })
  @Column({ nullable: true })
  jobId?: string;

  @ApiProperty({ description: '处理的订单数量' })
  @Column({ default: 0 })
  ordersProcessed: number;

  @ApiProperty({ description: '总订单数量' })
  @Column({ default: 0 })
  totalOrders: number;

  @ApiProperty({ description: '错误信息（如果有）' })
  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @ApiProperty({ description: '识别到的订单ID列表', type: [String] })
  @Column('text', { array: true, default: [] })
  orderIds: string[];

  @ApiProperty({ description: '识别到的SKU列表', type: [String] })
  @Column('text', { array: true, default: [] })
  skus: string[];

  @ApiProperty({ description: '上传时选择的订单类型：all 或 SKU 类型（maternal_baby / combo / sweater）；旧记录可能为 basket / backpack', default: 'all' })
  @Column({ default: 'basket' })
  orderType: string;

  @ApiProperty({ description: '上传的原始 Excel 路径' })
  @Column({ name: 'source_file_path', type: 'varchar', nullable: true })
  sourceFilePath: string | null;

  @ApiProperty({ description: '明细行数（含重复行）' })
  @Column({ name: 'lines_total', default: 0 })
  linesTotal: number;

  @ApiProperty({ description: '实际生成的制作单元数' })
  @Column({ name: 'units_produced', default: 0 })
  unitsProduced: number;

  @ApiProperty({ description: '异常行数' })
  @Column({ name: 'exception_count', default: 0 })
  exceptionCount: number;

  @ApiProperty({ description: '有提示的行数' })
  @Column({ name: 'warning_count', default: 0 })
  warningCount: number;

  @ApiProperty({ description: '重新生成前的历史输出（备份）' })
  @Column({ name: 'previous_outputs', type: 'jsonb', default: [] })
  previousOutputs: Array<{ outputFilePath: string; replacedAt: string }>;

  @ApiProperty({ description: '补处理记录：来源记录ID' })
  @Column({ name: 'reprocess_of_record_id', type: 'int', nullable: true })
  reprocessOfRecordId: number | null;

  @Column({ name: 'pipeline_version', type: 'varchar', nullable: true })
  pipelineVersion: string | null;

  @ApiProperty({ description: '创建用户ID' })
  @Column({ nullable: true })
  userId: string;

  @ApiProperty({ description: '创建用户' })
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'userId' })
  user: User;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
} 