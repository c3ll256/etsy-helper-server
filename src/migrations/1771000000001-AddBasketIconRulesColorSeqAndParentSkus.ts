import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 2026-11-23：
 * - sku_configs.require_review_on_icons：含图标时强制进入待核对
 * - color_kv.color_sequence：混色毛线颜色顺序（用于混色名字 + 毛线图标自动算色与撞色跳色）
 * - sku_parent_groups：总 SKU（母体分组）统一配置表，通过 group_key 与 sku_configs.reference_group_key 关联
 */
export class AddBasketIconRulesColorSeqAndParentSkus1771000000001 implements MigrationInterface {
  name = 'AddBasketIconRulesColorSeqAndParentSkus1771000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "require_review_on_icons" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "color_kv" ADD COLUMN IF NOT EXISTS "color_sequence" jsonb NULL`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sku_parent_groups" (
        "id" SERIAL PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "group_key" varchar NOT NULL,
        "name" varchar NULL,
        "font" varchar NULL,
        "font_size" double precision NULL,
        "color_group_id" bigint NULL REFERENCES "color_groups"("id") ON DELETE SET NULL,
        "icon_group_id" bigint NULL REFERENCES "icon_groups"("id") ON DELETE SET NULL,
        "produce_mode" varchar(16) NOT NULL DEFAULT 'ppt',
        "icon_layout_template_id" integer NULL REFERENCES "basket_icon_layout_templates"("id") ON DELETE SET NULL,
        "max_icons" integer NULL,
        "require_review_on_icons" boolean NOT NULL DEFAULT false,
        "name_layout" jsonb NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_sku_parent_groups_user_key" UNIQUE ("user_id", "group_key")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sku_parent_groups_user" ON "sku_parent_groups" ("user_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sku_parent_groups"`);
    await queryRunner.query(`ALTER TABLE "color_kv" DROP COLUMN IF EXISTS "color_sequence"`);
    await queryRunner.query(`ALTER TABLE "sku_configs" DROP COLUMN IF EXISTS "require_review_on_icons"`);
  }
}
