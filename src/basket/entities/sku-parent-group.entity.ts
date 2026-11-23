import { ApiProperty } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ColorGroup } from './color-group.entity';
import { IconGroup } from './icon-group.entity';

/** 总 SKU（母体分组）：统一管理同一款子 SKU 的生成与排版、字体、参考图共用分组 */
@Entity('sku_parent_groups')
@Unique(['userId', 'groupKey'])
export class SkuParentGroup {
  @PrimaryGeneratedColumn()
  @ApiProperty({ description: '总 SKU 分组 ID' })
  id: number;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', name: 'group_key' })
  @ApiProperty({ description: '总 SKU 编码 / 母体分组标识（与子 SKU 的 referenceGroupKey 对应）' })
  groupKey: string;

  @Column({ type: 'varchar', nullable: true })
  @ApiProperty({ description: '总 SKU 名称 / 说明', required: false })
  name?: string | null;

  @Column({ type: 'varchar', nullable: true })
  @ApiProperty({ description: '统一字体名称', required: false })
  font?: string | null;

  @Column({ type: 'float', name: 'font_size', nullable: true })
  @ApiProperty({ description: '统一默认字号', required: false })
  fontSize?: number | null;

  @Column({ type: 'bigint', name: 'color_group_id', nullable: true })
  @ApiProperty({ description: '统一颜色组 ID', required: false })
  colorGroupId?: number | null;

  @ManyToOne(() => ColorGroup, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'color_group_id' })
  colorGroup?: ColorGroup | null;

  @Column({ type: 'bigint', name: 'icon_group_id', nullable: true })
  @ApiProperty({ description: '统一图标组 ID', required: false })
  iconGroupId?: number | null;

  @ManyToOne(() => IconGroup, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'icon_group_id' })
  iconGroup?: IconGroup | null;

  @Column({ type: 'varchar', length: 16, name: 'produce_mode', default: 'ppt' })
  @ApiProperty({ description: '生成方式：ppt / external / ignore', default: 'ppt' })
  produceMode: 'ppt' | 'external' | 'ignore';

  @Column({ type: 'int', name: 'icon_layout_template_id', nullable: true })
  @ApiProperty({ description: '统一图标布局模板 ID', required: false })
  iconLayoutTemplateId?: number | null;

  @Column({ type: 'int', name: 'max_icons', nullable: true })
  @ApiProperty({ description: '每件图标上限', required: false })
  maxIcons?: number | null;

  @Column({ type: 'boolean', name: 'require_review_on_icons', default: false })
  @ApiProperty({ description: '含图标时强制进入待核对', default: false })
  requireReviewOnIcons: boolean;

  @Column({ type: 'jsonb', name: 'name_layout', nullable: true })
  @ApiProperty({ description: '统一名字安全区和字号', required: false, type: Object })
  nameLayout?: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
