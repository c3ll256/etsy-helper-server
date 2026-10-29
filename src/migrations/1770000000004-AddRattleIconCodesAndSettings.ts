import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRattleIconCodesAndSettings1770000000004 implements MigrationInterface {
  name = 'AddRattleIconCodesAndSettings1770000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 摇铃图标按"图标组 + 完整编号"识别（R3），如 A 组的 A1、C 组的 C10
    await queryRunner.query('ALTER TABLE "rattle_icon_assets" ADD COLUMN IF NOT EXISTS "group_code" VARCHAR(16)');
    await queryRunner.query('ALTER TABLE "rattle_icon_assets" ADD COLUMN IF NOT EXISTS "code" VARCHAR(32)');
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rattle_icon_assets_code" ON "rattle_icon_assets" (UPPER("code")) WHERE "code" IS NOT NULL AND "is_active" = true'
    );

    // 摇铃生成记录清理（R4）：清理后文件移到回收目录，记录保留
    await queryRunner.query('ALTER TABLE "stamp_generation_records" ADD COLUMN IF NOT EXISTS "cleanedAt" TIMESTAMP WITH TIME ZONE');
    await queryRunner.query('ALTER TABLE "stamp_generation_records" ADD COLUMN IF NOT EXISTS "trashPath" VARCHAR');

    // 通用配置（如摇铃十列导出的字段来源，R5）
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "app_settings" (
        "key" VARCHAR(64) PRIMARY KEY,
        "value" JSONB NOT NULL,
        "updatedBy" UUID,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "app_settings"');
    await queryRunner.query('ALTER TABLE "stamp_generation_records" DROP COLUMN IF EXISTS "trashPath"');
    await queryRunner.query('ALTER TABLE "stamp_generation_records" DROP COLUMN IF EXISTS "cleanedAt"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_rattle_icon_assets_code"');
    await queryRunner.query('ALTER TABLE "rattle_icon_assets" DROP COLUMN IF EXISTS "code"');
    await queryRunner.query('ALTER TABLE "rattle_icon_assets" DROP COLUMN IF EXISTS "group_code"');
  }
}
