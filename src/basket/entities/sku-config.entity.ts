import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ApiProperty } from '@nestjs/swagger';
import { ColorGroup } from './color-group.entity';
import { IconGroup } from './icon-group.entity';

export enum SkuType {
  MATERNAL_BABY = 'maternal_baby',
  SWEATER = 'sweater',
  COMBO = 'combo'
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
    type: 'varchar',
    length: 32,
    default: SkuType.MATERNAL_BABY
  })
  @ApiProperty({ description: 'SKU类型：母婴、毛衣或套组', enum: SkuType })
  type: SkuType;

  @Column({ nullable: true })
  @ApiProperty({ description: '替换后的显示文本' })
  replaceValue: string;

  @Column({ type: 'float', nullable: true })
  @ApiProperty({ description: '字体大小' })
  fontSize: number;

  @Column({ nullable: true })
  @ApiProperty({ description: '字体名称' })
  font: string;

  @Column({ type: 'jsonb', nullable: true })
  @ApiProperty({ description: 'Yarn 颜色替换映射(JSON 对象)。例如 {"Cream": "奶油色"}', required: false, type: Object })
  yarnColorMap: Record<string, string>;

  @Column({ type: 'jsonb', nullable: true })
  @ApiProperty({ description: '套组款式数组，例如 ["SKU1", "SKU2"]', required: false, type: Array })
  comboItems?: string[];

  @Column({ type: 'bigint', nullable: true, name: 'color_group_id' })
  @ApiProperty({ description: '颜色组ID', required: false })
  colorGroupId?: number | null;

  @ManyToOne(() => ColorGroup, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'color_group_id' })
  @ApiProperty({ description: '颜色组', required: false, type: () => ColorGroup })
  colorGroup?: ColorGroup | null;

  @Column({ type: 'bigint', nullable: true, name: 'icon_group_id' })
  @ApiProperty({ description: '图标组ID', required: false })
  iconGroupId?: number | null;

  @ManyToOne(() => IconGroup, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'icon_group_id' })
  @ApiProperty({ description: '图标组', required: false, type: () => IconGroup })
  iconGroup?: IconGroup | null;

  @Column({ type: 'jsonb', nullable: true, name: 'combo_overrides_json' })
  @ApiProperty({
    description: '套组子 SKU 覆盖配置',
    required: false,
    type: Object,
    example: {
      'CHILD-SKU-A': {
        fontSize: 18,
        colorGroupId: 12,
        iconGroupId: 5,
      },
    },
  })
  comboOverridesJson?: Record<string, { fontSize?: number; colorGroupId?: number; iconGroupId?: number; iconLayoutTemplateId?: number; maxIcons?: number; nameLayout?: Record<string, any> }> | null;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: '外部订单提醒开关' })
  externalOrderReminderEnabled: boolean;

  @Column({ nullable: true })
  @ApiProperty({ description: '外部订单提醒内容', required: false })
  externalOrderReminderContent: string;

  @Column({ type: 'varchar', length: 16, name: 'produce_mode', default: 'ppt' })
  @ApiProperty({ description: '生成方式：ppt 生成制作页；external 正常连单商品（不做 PPT，只在同订单页上提醒）；ignore 非商品行（如补差价），不提醒', default: 'ppt' })
  produceMode: 'ppt' | 'external' | 'ignore';

  @Column({ type: 'int', name: 'icon_layout_template_id', nullable: true })
  @ApiProperty({ description: '图标布局模板ID', required: false })
  iconLayoutTemplateId?: number | null;

  @Column({ type: 'int', name: 'max_icons', nullable: true })
  @ApiProperty({ description: '每件商品最多几个图标，超过进入待核对；空表示不限', required: false })
  maxIcons?: number | null;

  @Column({ type: 'boolean', name: 'require_review_on_icons', default: false })
  @ApiProperty({ description: '含图标时强制进入待核对（用于复杂图标款式兜底人工审核）', default: false })
  requireReviewOnIcons: boolean;

  @Column({ type: 'jsonb', name: 'name_layout', nullable: true })
  @ApiProperty({ description: '名字安全区和字号：{area:{x1,x2,y1,y2}(百分比), maxFontSize, minFontSize, preferredFontSize, allowTwoLines, maxLatinLetters, bufferPt, twoLineNote, presetKey, confirmed}', required: false, type: Object })
  nameLayout?: Record<string, any> | null;

  @Column({ type: 'varchar', name: 'reference_group_key', nullable: true })
  @ApiProperty({ description: '母体（参考图共用分组）', required: false })
  referenceGroupKey?: string | null;

  @Column({ type: 'int', name: 'copied_from_id', nullable: true })
  @ApiProperty({ description: '从哪条配置复制而来', required: false })
  copiedFromId?: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  @ApiProperty({ description: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  @ApiProperty({ description: '更新时间' })
  updatedAt: Date;
} 
