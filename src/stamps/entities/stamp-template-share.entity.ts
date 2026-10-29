import { Column, CreateDateColumn, Entity, Index, ManyToOne, JoinColumn, PrimaryGeneratedColumn } from 'typeorm';
import { StampTemplate } from './stamp-template.entity';

/**
 * 模板授权：被授权账号可以查看、在导入匹配和手动选模板时使用原模板（共用同一份），
 * 但不能修改或删除；需要独立维护时用"复制模板"。
 */
@Entity('stamp_template_shares')
@Index(['templateId', 'granteeUserId'], { unique: true })
export class StampTemplateShare {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  templateId: number;

  @ManyToOne(() => StampTemplate, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'templateId' })
  template: StampTemplate;

  @Column({ type: 'uuid' })
  granteeUserId: string;

  @Column({ type: 'varchar', length: 16, default: 'use' })
  permission: 'use';

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
