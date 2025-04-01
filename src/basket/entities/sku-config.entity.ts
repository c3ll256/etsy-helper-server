import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ApiProperty } from '@nestjs/swagger';

export enum SkuType {
  BASKET = 'basket',
  BACKPACK = 'backpack'
}

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

  @Column()
  @ApiProperty({ description: 'SKU编码' })
  sku: string;

  @Column({
    type: 'enum',
    enum: SkuType,
    default: SkuType.BASKET
  })
  @ApiProperty({ description: 'SKU类型：篮子或书包', enum: SkuType })
  type: SkuType;

  @Column({ nullable: true })
  @ApiProperty({ description: '替换后的显示文本' })
  replaceValue: string;

  @Column({ type: 'float', nullable: true })
  @ApiProperty({ description: '字体大小' })
  fontSize: number;

  @CreateDateColumn()
  @ApiProperty({ description: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn()
  @ApiProperty({ description: '更新时间' })
  updatedAt: Date;
} 