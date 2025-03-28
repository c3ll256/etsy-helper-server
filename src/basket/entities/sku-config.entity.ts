import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ApiProperty } from '@nestjs/swagger';

@Entity('sku_configs')
export class SkuConfig {
  @PrimaryGeneratedColumn()
  @ApiProperty({ description: '配置ID' })
  id: number;

  @Column()
  @ApiProperty({ description: '用户ID' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  @ApiProperty({ description: '用户信息' })
  user: User;

  @Column('simple-array', { nullable: true })
  @ApiProperty({ description: '篮子SKU关键词', type: [String] })
  basketSkuKeys: string[];

  @Column('simple-array', { nullable: true })
  @ApiProperty({ description: '背包SKU关键词', type: [String] })
  backpackSkuKeys: string[];

  @CreateDateColumn()
  @ApiProperty({ description: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn()
  @ApiProperty({ description: '更新时间' })
  updatedAt: Date;
} 