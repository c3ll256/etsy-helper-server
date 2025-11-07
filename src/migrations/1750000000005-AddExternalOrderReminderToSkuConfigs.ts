import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExternalOrderReminderToSkuConfigs1750000000005 implements MigrationInterface {
  name = 'AddExternalOrderReminderToSkuConfigs1750000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add externalOrderReminderEnabled column with default value false
    await queryRunner.query(
      'ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "externalOrderReminderEnabled" boolean NOT NULL DEFAULT false'
    );

    // Add externalOrderReminderContent column (nullable)
    await queryRunner.query(
      'ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "externalOrderReminderContent" character varying'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove externalOrderReminderContent column
    await queryRunner.query(
      'ALTER TABLE "sku_configs" DROP COLUMN IF EXISTS "externalOrderReminderContent"'
    );

    // Remove externalOrderReminderEnabled column
    await queryRunner.query(
      'ALTER TABLE "sku_configs" DROP COLUMN IF EXISTS "externalOrderReminderEnabled"'
    );
  }
}

