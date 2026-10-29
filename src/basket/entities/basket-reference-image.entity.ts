import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * SKU 母体制作参考图。
 * - skuConfigId 为空、groupKey 有值：同一母体（groupKey）的多个 SKU 共用
 * - skuConfigId 有值：该 SKU 单独的参考图，有则覆盖共用图
 * 参考图只在配置页和审核页展示，不进入 PPT，也不会被带入顾客订单（展示范围待甲方确认）
 */
@Entity('basket_reference_images')
export class BasketReferenceImage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @Column({ name: 'group_key', type: 'varchar', nullable: true })
  groupKey: string | null;

  @Column({ name: 'sku_config_id', type: 'int', nullable: true })
  skuConfigId: number | null;

  @Column({ name: 'file_name' })
  fileName: string;

  @Column({ name: 'file_path' })
  filePath: string;

  @Column({ name: 'mime_type', type: 'varchar', nullable: true })
  mimeType: string | null;

  @Column({ type: 'varchar', nullable: true })
  caption: string | null;

  @Column({ name: 'sort_order', default: 0 })
  sortOrder: number;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
