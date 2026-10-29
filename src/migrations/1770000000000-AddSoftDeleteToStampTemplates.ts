import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSoftDeleteToStampTemplates1770000000000 implements MigrationInterface {
  name = 'AddSoftDeleteToStampTemplates1770000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 删除模板改为软删除，避免破坏历史订单的模板关联和生成记录
    await queryRunner.query(
      'ALTER TABLE "stamp_templates" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP WITH TIME ZONE'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "stamp_templates" DROP COLUMN IF EXISTS "deletedAt"');
  }
}
