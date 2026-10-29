import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderMatchStatusAndBackups1770000000001 implements MigrationInterface {
  name = 'AddOrderMatchStatusAndBackups1770000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 匹配状态：exact / unmatched / conflict / manual / mismatch / legacy，历史订单为空，由匹配审计补齐
    await queryRunner.query('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "matchStatus" VARCHAR(16)');
    await queryRunner.query('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "matchDetail" JSONB');
    // 人工在审核页调整过设计的时间，重匹配 / 重生成前据此提示覆盖影响
    await queryRunner.query('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "designAdjustedAt" TIMESTAMP WITH TIME ZONE');
    // 解析失败等处理异常，进入待处理清单
    await queryRunner.query('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "processingError" TEXT');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_orders_matchStatus" ON "orders" ("matchStatus")');

    // 导入时的原始整行，备注列名不确定时也能事后补显示
    await queryRunner.query('ALTER TABLE "etsy_orders" ADD COLUMN IF NOT EXISTS "rawRow" JSONB');
    await queryRunner.query('ALTER TABLE "etsy_orders" ADD COLUMN IF NOT EXISTS "buyerNoteSource" VARCHAR(16)');

    // 覆盖设计前的备份
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_design_backups" (
        "id" SERIAL PRIMARY KEY,
        "orderId" UUID NOT NULL,
        "templateId" INTEGER,
        "status" VARCHAR(64),
        "matchStatus" VARCHAR(16),
        "stampImageUrls" JSONB,
        "stampGenerationRecordIds" JSONB,
        "variations" JSONB,
        "reason" VARCHAR(64) NOT NULL,
        "createdBy" UUID,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_order_design_backups_orderId" ON "order_design_backups" ("orderId")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "order_design_backups"');
    await queryRunner.query('ALTER TABLE "etsy_orders" DROP COLUMN IF EXISTS "buyerNoteSource"');
    await queryRunner.query('ALTER TABLE "etsy_orders" DROP COLUMN IF EXISTS "rawRow"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_orders_matchStatus"');
    await queryRunner.query('ALTER TABLE "orders" DROP COLUMN IF EXISTS "processingError"');
    await queryRunner.query('ALTER TABLE "orders" DROP COLUMN IF EXISTS "designAdjustedAt"');
    await queryRunner.query('ALTER TABLE "orders" DROP COLUMN IF EXISTS "matchDetail"');
    await queryRunner.query('ALTER TABLE "orders" DROP COLUMN IF EXISTS "matchStatus"');
  }
}
