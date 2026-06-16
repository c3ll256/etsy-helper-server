import { ApiProperty } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ColorGroup } from './color-group.entity';

@Entity('color_kv')
export class ColorKv {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  @ApiProperty({ description: '颜色字典ID' })
  id: number;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  @ApiProperty({ description: '所属用户ID', required: false })
  userId?: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user?: User | null;

  @Column({ type: 'bigint', nullable: true, name: 'group_id' })
  @ApiProperty({ description: '颜色组ID', required: false, nullable: true })
  groupId?: number | null;

  @ManyToOne(() => ColorGroup, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'group_id' })
  @ApiProperty({ description: '所属颜色组', required: false, nullable: true, type: () => ColorGroup })
  group?: ColorGroup | null;

  @Column({ type: 'varchar' })
  @ApiProperty({ description: '颜色原词' })
  name: string;

  @Column({ type: 'varchar', name: 'color_value' })
  @ApiProperty({ description: '映射后的颜色值' })
  colorValue: string;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  @ApiProperty({ description: '是否启用' })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  @ApiProperty({ description: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  @ApiProperty({ description: '更新时间' })
  updatedAt: Date;
}
