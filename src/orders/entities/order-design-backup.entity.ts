import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** 重匹配 / 重生成 / 换模板覆盖设计前的快照，旧图片文件不删除 */
@Entity('order_design_backups')
export class OrderDesignBackup {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'uuid' })
  orderId: string;

  @Column({ type: 'int', nullable: true })
  templateId: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  status: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  matchStatus: string | null;

  @Column({ type: 'jsonb', nullable: true })
  stampImageUrls: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  stampGenerationRecordIds: number[] | null;

  @Column({ type: 'jsonb', nullable: true })
  variations: any;

  @Column({ type: 'varchar', length: 64 })
  reason: string;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
