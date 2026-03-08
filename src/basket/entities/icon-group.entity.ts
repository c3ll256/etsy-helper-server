import { ApiProperty } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('icon_groups')
export class IconGroup {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  @ApiProperty({ description: '图标组ID' })
  id: number;

  @Column({ type: 'uuid', name: 'user_id' })
  @ApiProperty({ description: '所属用户ID' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar' })
  @ApiProperty({ description: '图标组名称' })
  name: string;

  @Column({ type: 'text', nullable: true })
  @ApiProperty({ description: '图标组描述', required: false })
  description?: string | null;

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
