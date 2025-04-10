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

  @ApiProperty({ description: '处理状态', enum: ['pending', 'processing', 'completed', 'failed'] })
  @Column({ default: 'pending' })
  status: 'pending' | 'processing' | 'completed' | 'failed';

  @ApiProperty({ description: '处理进度 (0-100)' })
  @Column({ type: 'float', default: 0 })
  progress: number;

  @ApiProperty({ description: '生成的PPT文件路径' })
  @Column({ nullable: true })
  outputFilePath: string;

  @ApiProperty({ description: '处理的订单数量' })
  @Column({ default: 0 })
  ordersProcessed: number;

  @ApiProperty({ description: '总订单数量' })
  @Column({ default: 0 })
  totalOrders: number;

  @ApiProperty({ description: '错误信息（如果有）' })
  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @ApiProperty({ description: '订单类型', enum: ['basket', 'backpack', 'all'], default: 'basket' })
  @Column({ default: 'basket' })
  orderType: 'basket' | 'backpack' | 'all';

  @ApiProperty({ description: '创建用户ID' })
  @Column({ nullable: true })
  userId: string;

  @ApiProperty({ description: '创建用户' })
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'userId' })
  user: User;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;
} 