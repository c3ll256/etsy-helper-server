import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProductTypeToIconGroups1760000000004 implements MigrationInterface {
  name = 'AddProductTypeToIconGroups1760000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "color_groups" ADD COLUMN IF NOT EXISTS "product_type" varchar');
    await queryRunner.query('ALTER TABLE "icon_groups" ADD COLUMN IF NOT EXISTS "product_type" varchar');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "icon_groups" DROP COLUMN IF EXISTS "product_type"');
  }
}
