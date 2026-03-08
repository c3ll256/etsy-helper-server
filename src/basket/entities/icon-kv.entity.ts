import { ApiProperty } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { IconGroup } from './icon-group.entity';

@Entity('icon_kv')
export class IconKv {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  @ApiProperty({ description: '图标字典ID' })
  id: number;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  @ApiProperty({ description: '所属用户ID', required: false })
  userId?: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user?: User | null;

  @Column({ type: 'bigint', nullable: true, name: 'group_id' })
  @ApiProperty({ description: '图标组ID', required: false, nullable: true })
  groupId?: number | null;

  @ManyToOne(() => IconGroup, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'group_id' })
  @ApiProperty({ description: '所属图标组', required: false, nullable: true, type: () => IconGroup })
  group?: IconGroup | null;

  @Column({ type: 'varchar' })
  @ApiProperty({ description: '图标词条' })
  name: string;

  @Column({ type: 'varchar', name: 'file_name' })
  @ApiProperty({ description: '文件名' })
  fileName: string;

  @Column({ type: 'varchar', name: 'file_path' })
  @ApiProperty({ description: '文件路径' })
  filePath: string;

  @Column({ type: 'varchar', name: 'mime_type' })
  @ApiProperty({ description: '文件 MIME 类型' })
  mimeType: string;

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
