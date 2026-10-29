import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** 按店铺（账号）的母婴生成开关，例如特殊字符标注是否启用、标注字号 */
@Entity('basket_shop_settings')
export class BasketShopSettings {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId: string;

  @Column({ type: 'jsonb', default: {} })
  settings: Record<string, any>;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
