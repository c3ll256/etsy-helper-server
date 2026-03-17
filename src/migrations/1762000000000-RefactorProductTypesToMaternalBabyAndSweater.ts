import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefactorProductTypesToMaternalBabyAndSweater1762000000000 implements MigrationInterface {
  name = 'RefactorProductTypesToMaternalBabyAndSweater1762000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 更新颜色组的产品类型
    // 将 basket 和 backpack 转换为 maternal_baby
    await queryRunner.query(`
      UPDATE "color_groups"
      SET "product_type" = 'maternal_baby'
      WHERE "product_type" IN ('basket', 'backpack')
    `);

    // sweater 保持不变
    await queryRunner.query(`
      UPDATE "color_groups"
      SET "product_type" = 'sweater'
      WHERE "product_type" = 'sweater'
    `);

    // 对于 null 值，设置默认值为 maternal_baby（可根据业务需求调整）
    await queryRunner.query(`
      UPDATE "color_groups"
      SET "product_type" = 'maternal_baby'
      WHERE "product_type" IS NULL
    `);

    // 2. 更新图标组的产品类型
    await queryRunner.query(`
      UPDATE "icon_groups"
      SET "product_type" = 'maternal_baby'
      WHERE "product_type" IN ('basket', 'backpack')
    `);

    await queryRunner.query(`
      UPDATE "icon_groups"
      SET "product_type" = 'sweater'
      WHERE "product_type" = 'sweater'
    `);

    await queryRunner.query(`
      UPDATE "icon_groups"
      SET "product_type" = 'maternal_baby'
      WHERE "product_type" IS NULL
    `);

    // 3. 更新SKU配置的类型
    await queryRunner.query(`
      UPDATE "sku_configs"
      SET "type" = 'maternal_baby'
      WHERE "type" IN ('basket', 'backpack')
    `);

    await queryRunner.query(`
      UPDATE "sku_configs"
      SET "type" = 'sweater'
      WHERE "type" = 'sweater'
    `);

    // 4. 将产品类型字段设为非空
    await queryRunner.query(`
      ALTER TABLE "color_groups"
      ALTER COLUMN "product_type" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "icon_groups"
      ALTER COLUMN "product_type" SET NOT NULL
    `);

    // 5. 添加约束确保只能是指定的值
    await queryRunner.query(`
      ALTER TABLE "color_groups"
      ADD CONSTRAINT "CHK_color_groups_product_type"
      CHECK ("product_type" IN ('maternal_baby', 'sweater'))
    `);

    await queryRunner.query(`
      ALTER TABLE "icon_groups"
      ADD CONSTRAINT "CHK_icon_groups_product_type"
      CHECK ("product_type" IN ('maternal_baby', 'sweater'))
    `);

    await queryRunner.query(`
      ALTER TABLE "sku_configs"
      ADD CONSTRAINT "CHK_sku_configs_type"
      CHECK ("type" IN ('maternal_baby', 'sweater', 'combo'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 移除约束
    await queryRunner.query(`
      ALTER TABLE "sku_configs"
      DROP CONSTRAINT IF EXISTS "CHK_sku_configs_type"
    `);

    await queryRunner.query(`
      ALTER TABLE "icon_groups"
      DROP CONSTRAINT IF EXISTS "CHK_icon_groups_product_type"
    `);

    await queryRunner.query(`
      ALTER TABLE "color_groups"
      DROP CONSTRAINT IF EXISTS "CHK_color_groups_product_type"
    `);

    // 恢复产品类型字段为可空
    await queryRunner.query(`
      ALTER TABLE "icon_groups"
      ALTER COLUMN "product_type" DROP NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "color_groups"
      ALTER COLUMN "product_type" DROP NOT NULL
    `);

    // 恢复原始值（注意：这可能会丢失一些信息，因为我们将 basket 和 backpack 合并了）
    await queryRunner.query(`
      UPDATE "sku_configs"
      SET "type" = 'basket'
      WHERE "type" = 'maternal_baby'
    `);

    await queryRunner.query(`
      UPDATE "icon_groups"
      SET "product_type" = 'basket'
      WHERE "product_type" = 'maternal_baby'
    `);

    await queryRunner.query(`
      UPDATE "color_groups"
      SET "product_type" = 'basket'
      WHERE "product_type" = 'maternal_baby'
    `);
  }
}