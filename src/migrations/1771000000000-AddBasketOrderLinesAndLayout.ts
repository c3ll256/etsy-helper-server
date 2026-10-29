import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 母婴 v2（M3）：
 * - basket_order_lines：每行 Excel 明细落库（去重、解析、匹配、制作单元、连单核对、异常清单、NOTE、重处理的基础）
 * - basket_icon_layout_templates：独立的图标布局模板，由 SKU 选择
 * - basket_reference_images：SKU 母体制作参考图（共用 / 单独覆盖）
 * - basket_shop_settings：按店铺（账号）的特殊字符标注等开关
 * - sku_configs / icon_kv / basket_generation_records 新增字段
 * 全部是新增表或新增可空 / 有默认值的列，不改动已有数据。
 */
export class AddBasketOrderLinesAndLayout1771000000000 implements MigrationInterface {
  name = 'AddBasketOrderLinesAndLayout1771000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "basket_icon_layout_templates" (
        "id" SERIAL PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "name" varchar NOT NULL,
        "description" text,
        "slots" jsonb NOT NULL DEFAULT '[]',
        "rules" jsonb NOT NULL DEFAULT '[]',
        "default_order" jsonb NOT NULL DEFAULT '[]',
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "produce_mode" varchar(16) NOT NULL DEFAULT 'ppt'`);
    await queryRunner.query(`ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "icon_layout_template_id" integer NULL REFERENCES "basket_icon_layout_templates"("id") ON DELETE SET NULL`);
    await queryRunner.query(`ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "max_icons" integer NULL`);
    await queryRunner.query(`ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "name_layout" jsonb NULL`);
    await queryRunner.query(`ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "reference_group_key" varchar NULL`);
    await queryRunner.query(`ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "copied_from_id" integer NULL`);

    await queryRunner.query(`ALTER TABLE "icon_kv" ADD COLUMN IF NOT EXISTS "code" varchar NULL`);
    await queryRunner.query(`ALTER TABLE "icon_kv" ADD COLUMN IF NOT EXISTS "aliases" jsonb NULL`);
    await queryRunner.query(`ALTER TABLE "icon_kv" ADD COLUMN IF NOT EXISTS "kind" varchar(16) NOT NULL DEFAULT 'large'`);

    await queryRunner.query(`ALTER TABLE "basket_generation_records" ADD COLUMN IF NOT EXISTS "source_file_path" varchar NULL`);
    await queryRunner.query(`ALTER TABLE "basket_generation_records" ADD COLUMN IF NOT EXISTS "lines_total" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "basket_generation_records" ADD COLUMN IF NOT EXISTS "units_produced" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "basket_generation_records" ADD COLUMN IF NOT EXISTS "exception_count" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "basket_generation_records" ADD COLUMN IF NOT EXISTS "warning_count" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "basket_generation_records" ADD COLUMN IF NOT EXISTS "previous_outputs" jsonb NOT NULL DEFAULT '[]'`);
    await queryRunner.query(`ALTER TABLE "basket_generation_records" ADD COLUMN IF NOT EXISTS "reprocess_of_record_id" integer NULL`);
    await queryRunner.query(`ALTER TABLE "basket_generation_records" ADD COLUMN IF NOT EXISTS "pipeline_version" varchar NULL`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "basket_order_lines" (
        "id" SERIAL PRIMARY KEY,
        "record_id" integer NOT NULL REFERENCES "basket_generation_records"("id") ON DELETE CASCADE,
        "user_id" uuid NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "row_index" integer NOT NULL,
        "order_id" varchar NOT NULL DEFAULT '',
        "transaction_id" varchar NULL,
        "sku" varchar NOT NULL DEFAULT '',
        "item_name" text NULL,
        "quantity" integer NOT NULL DEFAULT 1,
        "quantity_raw" varchar NULL,
        "variations_raw" text NOT NULL DEFAULT '',
        "note_raw" text NULL,
        "ship_name" varchar NULL,
        "order_date" varchar NULL,
        "date_paid" varchar NULL,
        "raw_row" jsonb NOT NULL DEFAULT '{}',
        "dedupe_key" text NOT NULL DEFAULT '',
        "duplicate_of_line_id" integer NULL,
        "match_status" varchar(16) NOT NULL DEFAULT 'none',
        "sku_config_id" integer NULL,
        "matched_sku" varchar NULL,
        "match_note" text NULL,
        "produce_mode" varchar(16) NULL,
        "parse_source" varchar(16) NULL,
        "parse_result" jsonb NULL,
        "manual_override" jsonb NULL,
        "status" varchar(24) NOT NULL DEFAULT 'pending',
        "exception_category" varchar(32) NULL,
        "review_reasons" jsonb NOT NULL DEFAULT '[]',
        "warnings" jsonb NOT NULL DEFAULT '[]',
        "units" jsonb NOT NULL DEFAULT '[]',
        "expected_units" integer NOT NULL DEFAULT 0,
        "produced_units" integer NOT NULL DEFAULT 0,
        "produced_slides" jsonb NOT NULL DEFAULT '[]',
        "reminder_text" text NULL,
        "order_has_pages" boolean NOT NULL DEFAULT false,
        "resolution" varchar(24) NULL,
        "resolution_note" text NULL,
        "resolved_at" timestamptz NULL,
        "superseded_by_record_id" integer NULL,
        "source_line_id" integer NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_basket_order_lines_record" ON "basket_order_lines" ("record_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_basket_order_lines_order" ON "basket_order_lines" ("order_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_basket_order_lines_user_exc" ON "basket_order_lines" ("user_id", "exception_category")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "basket_reference_images" (
        "id" SERIAL PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "group_key" varchar NULL,
        "sku_config_id" integer NULL REFERENCES "sku_configs"("id") ON DELETE CASCADE,
        "file_name" varchar NOT NULL,
        "file_path" varchar NOT NULL,
        "mime_type" varchar NULL,
        "caption" varchar NULL,
        "sort_order" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "basket_shop_settings" (
        "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
        "settings" jsonb NOT NULL DEFAULT '{}',
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "basket_shop_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "basket_reference_images"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "basket_order_lines"`);
    for (const col of ['source_file_path', 'lines_total', 'units_produced', 'exception_count', 'warning_count', 'previous_outputs', 'reprocess_of_record_id', 'pipeline_version']) {
      await queryRunner.query(`ALTER TABLE "basket_generation_records" DROP COLUMN IF EXISTS "${col}"`);
    }
    for (const col of ['code', 'aliases', 'kind']) {
      await queryRunner.query(`ALTER TABLE "icon_kv" DROP COLUMN IF EXISTS "${col}"`);
    }
    for (const col of ['produce_mode', 'icon_layout_template_id', 'max_icons', 'name_layout', 'reference_group_key', 'copied_from_id']) {
      await queryRunner.query(`ALTER TABLE "sku_configs" DROP COLUMN IF EXISTS "${col}"`);
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "basket_icon_layout_templates"`);
  }
}
