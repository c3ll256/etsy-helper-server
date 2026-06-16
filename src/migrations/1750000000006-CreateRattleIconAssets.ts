import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRattleIconAssets1750000000006 implements MigrationInterface {
  name = 'CreateRattleIconAssets1750000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rattle_icon_assets" (
        "id" bigserial NOT NULL,
        "user_id" uuid NULL,
        "name" varchar NOT NULL,
        "file_path" varchar NOT NULL,
        "mime_type" varchar NOT NULL,
        "width" integer NULL,
        "height" integer NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_rattle_icon_assets_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_rattle_icon_assets_user_id_users_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_rattle_icon_assets_user_active"
      ON "rattle_icon_assets" ("user_id", "is_active")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_rattle_icon_assets_name"
      ON "rattle_icon_assets" ("name")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_rattle_icon_assets_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_rattle_icon_assets_user_active"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rattle_icon_assets"`);
  }
}
