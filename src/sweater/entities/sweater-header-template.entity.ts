import { ApiProperty } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';

export interface SweaterTemplateColumn {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  order: number;
}

export interface SweaterHeaderConfig {
  colorGroupIds: number[];
  columns: SweaterTemplateColumn[];
}

@Entity('sweater_header_templates')
export class SweaterHeaderTemplate {
  @ApiProperty({ description: '模板 ID' })
  @PrimaryGeneratedColumn()
  id: number;

  @ApiProperty({ description: '用户 ID' })
  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ApiProperty({ description: '模板名称' })
  @Column()
  name: string;

  @ApiProperty({ description: '表头配置 JSON', type: Object })
  @Column({ type: 'jsonb', name: 'header_config_json' })
  headerConfigJson: SweaterHeaderConfig;

  @ApiProperty({ description: '扩展映射配置 JSON', required: false, type: Object })
  @Column({ type: 'jsonb', name: 'mapping_config_json', nullable: true })
  mappingConfigJson?: Record<string, any> | null;

  @ApiProperty({ description: '是否启用' })
  @Column({ default: true, name: 'is_active' })
  isActive: boolean;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
