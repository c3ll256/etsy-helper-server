import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBabyProductDictionaries1760000000000 implements MigrationInterface {
  name = 'AddBabyProductDictionaries1760000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "color_groups" (
        "id" bigserial NOT NULL,
        "user_id" uuid NOT NULL,
        "name" varchar NOT NULL,
        "description" text NULL,
        "product_type" varchar NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_color_groups_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_color_groups_user_id_users_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "color_kv" (
        "id" bigserial NOT NULL,
        "user_id" uuid NULL,
        "group_id" bigint NOT NULL,
        "name" varchar NOT NULL,
        "color_value" varchar NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_color_kv_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_color_kv_user_id_users_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_color_kv_group_id_color_groups_id"
          FOREIGN KEY ("group_id") REFERENCES "color_groups"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "icon_groups" (
        "id" bigserial NOT NULL,
        "user_id" uuid NOT NULL,
        "name" varchar NOT NULL,
        "description" text NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_icon_groups_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_icon_groups_user_id_users_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "icon_kv" (
        "id" bigserial NOT NULL,
        "user_id" uuid NULL,
        "group_id" bigint NOT NULL,
        "name" varchar NOT NULL,
        "file_name" varchar NOT NULL,
        "file_path" varchar NOT NULL,
        "mime_type" varchar NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_icon_kv_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_icon_kv_user_id_users_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_icon_kv_group_id_icon_groups_id"
          FOREIGN KEY ("group_id") REFERENCES "icon_groups"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query('ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "color_group_id" bigint');
    await queryRunner.query('ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "icon_group_id" bigint');
    await queryRunner.query('ALTER TABLE "sku_configs" ADD COLUMN IF NOT EXISTS "combo_overrides_json" jsonb');

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_sku_configs_color_group_id_color_groups_id'
        ) THEN
          ALTER TABLE "sku_configs"
          ADD CONSTRAINT "FK_sku_configs_color_group_id_color_groups_id"
          FOREIGN KEY ("color_group_id") REFERENCES "color_groups"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_sku_configs_icon_group_id_icon_groups_id'
        ) THEN
          ALTER TABLE "sku_configs"
          ADD CONSTRAINT "FK_sku_configs_icon_group_id_icon_groups_id"
          FOREIGN KEY ("icon_group_id") REFERENCES "icon_groups"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_color_groups_user_active" ON "color_groups" ("user_id", "is_active")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_color_groups_name" ON "color_groups" ("name")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_color_kv_group_id" ON "color_kv" ("group_id")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_color_kv_name" ON "color_kv" ("name")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_icon_groups_user_active" ON "icon_groups" ("user_id", "is_active")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_icon_groups_name" ON "icon_groups" ("name")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_icon_kv_group_id" ON "icon_kv" ("group_id")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_icon_kv_name" ON "icon_kv" ("name")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_sku_configs_color_group_id" ON "sku_configs" ("color_group_id")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_sku_configs_icon_group_id" ON "sku_configs" ("icon_group_id")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "idx_sku_configs_icon_group_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_sku_configs_color_group_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_icon_kv_name"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_icon_kv_group_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_icon_groups_name"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_icon_groups_user_active"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_color_kv_name"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_color_kv_group_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_color_groups_name"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_color_groups_user_active"');

    await queryRunner.query('ALTER TABLE "sku_configs" DROP CONSTRAINT IF EXISTS "FK_sku_configs_icon_group_id_icon_groups_id"');
    await queryRunner.query('ALTER TABLE "sku_configs" DROP CONSTRAINT IF EXISTS "FK_sku_configs_color_group_id_color_groups_id"');
    await queryRunner.query('ALTER TABLE "sku_configs" DROP COLUMN IF EXISTS "combo_overrides_json"');
    await queryRunner.query('ALTER TABLE "sku_configs" DROP COLUMN IF EXISTS "icon_group_id"');
    await queryRunner.query('ALTER TABLE "sku_configs" DROP COLUMN IF EXISTS "color_group_id"');

    await queryRunner.query('DROP TABLE IF EXISTS "icon_kv"');
    await queryRunner.query('DROP TABLE IF EXISTS "icon_groups"');
    await queryRunner.query('DROP TABLE IF EXISTS "color_kv"');
    await queryRunner.query('DROP TABLE IF EXISTS "color_groups"');
  }
}
