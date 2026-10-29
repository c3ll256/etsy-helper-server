import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStampTemplateShares1770000000002 implements MigrationInterface {
  name = 'CreateStampTemplateShares1770000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "stamp_template_shares" (
        "id" SERIAL PRIMARY KEY,
        "templateId" INTEGER NOT NULL REFERENCES "stamp_templates"("id") ON DELETE CASCADE,
        "granteeUserId" UUID NOT NULL,
        "permission" VARCHAR(16) NOT NULL DEFAULT 'use',
        "createdBy" UUID,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_stamp_template_shares_template_grantee" ON "stamp_template_shares" ("templateId", "granteeUserId")'
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_stamp_template_shares_grantee" ON "stamp_template_shares" ("granteeUserId")'
    );
    // 摇铃多模板模式（R1）
    await queryRunner.query(
      'ALTER TABLE "stamp_templates" ADD COLUMN IF NOT EXISTS "allowMultipleForSku" BOOLEAN NOT NULL DEFAULT false'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "stamp_templates" DROP COLUMN IF EXISTS "allowMultipleForSku"');
    await queryRunner.query('DROP TABLE IF EXISTS "stamp_template_shares"');
  }
}
