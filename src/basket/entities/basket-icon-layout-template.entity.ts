import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

/** 图标布局模板：独立于产品分类，由 SKU 选择；一个模板可以给多个 SKU 用 */
@Entity('basket_icon_layout_templates')
export class BasketIconLayoutTemplate {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ApiProperty()
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @ApiProperty({ description: '位置：[{key,label,anchor:absolute|name_left|name_right,x,y,w,h,size}]，坐标为相对幻灯片的百分比' })
  @Column({ type: 'jsonb', default: [] })
  slots: any[];

  @ApiProperty({ description: '组合规则：[{large,flower,placements:[{slot,kind}],requiresReview}]' })
  @Column({ type: 'jsonb', default: [] })
  rules: any[];

  @ApiProperty({ description: '没有命中组合规则时依次使用的位置' })
  @Column({ type: 'jsonb', name: 'default_order', default: [] })
  defaultOrder: string[];

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
