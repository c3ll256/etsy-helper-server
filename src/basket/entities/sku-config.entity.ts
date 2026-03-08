import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ApiProperty } from '@nestjs/swagger';
import { ColorGroup } from './color-group.entity';
import { IconGroup } from './icon-group.entity';

export enum SkuType {
  BASKET = 'basket',
  BACKPACK = 'backpack',
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
    type: 'enum',
    enum: SkuType,
    default: SkuType.BASKET
  })
  @ApiProperty({ description: 'SKU类型：篮子、书包或套组', enum: SkuType })
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
  comboOverridesJson?: Record<string, { fontSize?: number; colorGroupId?: number; iconGroupId?: number }> | null;

  @Column({ type: 'boolean', default: false })
  @ApiProperty({ description: '外部订单提醒开关' })
  externalOrderReminderEnabled: boolean;

  @Column({ nullable: true })
  @ApiProperty({ description: '外部订单提醒内容', required: false })
  externalOrderReminderContent: string;

  @CreateDateColumn({ type: 'timestamptz' })
  @ApiProperty({ description: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  @ApiProperty({ description: '更新时间' })
  updatedAt: Date;
} 
