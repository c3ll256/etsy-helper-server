import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('rattle_icon_assets')
export class RattleIconAsset {
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'id' })
  id: number;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'varchar', name: 'name' })
  name: string;

  @Column({ type: 'varchar', name: 'file_path' })
  filePath: string;

  @Column({ type: 'varchar', name: 'mime_type' })
  mimeType: string;

  @Column({ type: 'int', nullable: true, name: 'width' })
  width: number | null;

  @Column({ type: 'int', nullable: true, name: 'height' })
  height: number | null;

  /** 图标组，如 A、C */
  @Column({ type: 'varchar', length: 16, nullable: true, name: 'group_code' })
  groupCode: string | null;

  /** 完整编号，如 A1、C10；订单里写的就是这个编号 */
  @Column({ type: 'varchar', length: 32, nullable: true, name: 'code' })
  code: string | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
