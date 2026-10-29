import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { BasketGenerationRecord } from './basket-generation-record.entity';

/** 母婴订单明细：上传 Excel 的每一行（含重复行）都落库，是去重、连单核对、异常清单、NOTE 展示、重处理的基础 */
@Entity('basket_order_lines')
@Index(['recordId'])
export class BasketOrderLine {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'record_id' })
  recordId: number;

  @ManyToOne(() => BasketGenerationRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'record_id' })
  record?: BasketGenerationRecord;

  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId: string | null;

  @ApiProperty({ description: 'Excel 行号（含表头，从 2 开始）' })
  @Column({ name: 'row_index' })
  rowIndex: number;

  @Column({ name: 'order_id', default: '' })
  orderId: string;

  @Column({ name: 'transaction_id', type: 'varchar', nullable: true })
  transactionId: string | null;

  @Column({ default: '' })
  sku: string;

  @Column({ name: 'item_name', type: 'text', nullable: true })
  itemName: string | null;

  @Column({ default: 1 })
  quantity: number;

  @Column({ name: 'quantity_raw', type: 'varchar', nullable: true })
  quantityRaw: string | null;

  @ApiProperty({ description: 'Variations 原文（不做任何清洗）' })
  @Column({ name: 'variations_raw', type: 'text', default: '' })
  variationsRaw: string;

  @ApiProperty({ description: 'NOTE 原文（含换行），只展示不执行' })
  @Column({ name: 'note_raw', type: 'text', nullable: true })
  noteRaw: string | null;

  @Column({ name: 'ship_name', type: 'varchar', nullable: true })
  shipName: string | null;

  @Column({ name: 'order_date', type: 'varchar', nullable: true })
  orderDate: string | null;

  @Column({ name: 'date_paid', type: 'varchar', nullable: true })
  datePaid: string | null;

  @ApiProperty({ description: '原始整行（表头 → 单元格）' })
  @Column({ name: 'raw_row', type: 'jsonb', default: {} })
  rawRow: Record<string, string>;

  @Column({ name: 'dedupe_key', type: 'text', default: '' })
  dedupeKey: string;

  @Column({ name: 'duplicate_of_line_id', type: 'int', nullable: true })
  duplicateOfLineId: number | null;

  @ApiProperty({ description: 'exact / prefix / unmatched / conflict / none' })
  @Column({ name: 'match_status', default: 'none' })
  matchStatus: string;

  @Column({ name: 'sku_config_id', type: 'int', nullable: true })
  skuConfigId: number | null;

  @Column({ name: 'matched_sku', type: 'varchar', nullable: true })
  matchedSku: string | null;

  @Column({ name: 'match_note', type: 'text', nullable: true })
  matchNote: string | null;

  @Column({ name: 'produce_mode', type: 'varchar', nullable: true })
  produceMode: string | null;

  @Column({ name: 'parse_source', type: 'varchar', nullable: true })
  parseSource: string | null;

  @Column({ name: 'parse_result', type: 'jsonb', nullable: true })
  parseResult: any;

  @ApiProperty({ description: '人工指定的名字 / 图标（逐件），重处理时优先使用' })
  @Column({ name: 'manual_override', type: 'jsonb', nullable: true })
  manualOverride: any;

  @ApiProperty({ description: 'produced / review / failed / unmatched / conflict / duplicate / external / ignored / out_of_scope' })
  @Column({ default: 'pending' })
  status: string;

  @Column({ name: 'exception_category', type: 'varchar', nullable: true })
  exceptionCategory: string | null;

  @Column({ name: 'review_reasons', type: 'jsonb', default: [] })
  reviewReasons: any[];

  @Column({ type: 'jsonb', default: [] })
  warnings: any[];

  @ApiProperty({ description: '制作单元（每件 / 每个组成件一页）及实际生成结果' })
  @Column({ type: 'jsonb', default: [] })
  units: any[];

  @Column({ name: 'expected_units', default: 0 })
  expectedUnits: number;

  @Column({ name: 'produced_units', default: 0 })
  producedUnits: number;

  @Column({ name: 'produced_slides', type: 'jsonb', default: [] })
  producedSlides: number[];

  @Column({ name: 'reminder_text', type: 'text', nullable: true })
  reminderText: string | null;

  @Column({ name: 'order_has_pages', default: false })
  orderHasPages: boolean;

  @ApiProperty({ description: '人工处理结果：ignored（已线下处理 / 不需要制作）、reprocessed（已补处理）' })
  @Column({ type: 'varchar', nullable: true })
  resolution: string | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'superseded_by_record_id', type: 'int', nullable: true })
  supersededByRecordId: number | null;

  @Column({ name: 'source_line_id', type: 'int', nullable: true })
  sourceLineId: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
