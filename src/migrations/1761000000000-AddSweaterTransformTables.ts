import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSweaterTransformTables1761000000000 implements MigrationInterface {
  name = 'AddSweaterTransformTables1761000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sku_configs" ALTER COLUMN "type" TYPE character varying(32)`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sweater_header_templates" (
        "id" SERIAL NOT NULL,
        "user_id" uuid NOT NULL,
        "name" character varying NOT NULL,
        "header_config_json" jsonb NOT NULL,
        "mapping_config_json" jsonb,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sweater_header_templates_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sweater_transform_jobs" (
        "id" SERIAL NOT NULL,
        "user_id" uuid NOT NULL,
        "template_id" bigint NOT NULL,
        "job_id" character varying NOT NULL,
        "input_file_name" character varying NOT NULL,
        "input_file_path" character varying NOT NULL,
        "output_file_path" character varying,
        "status" character varying NOT NULL DEFAULT 'pending',
        "progress" numeric(5,2) NOT NULL DEFAULT 0,
        "error_message" text,
        "total_rows" integer NOT NULL DEFAULT 0,
        "output_rows" integer NOT NULL DEFAULT 0,
        "started_at" TIMESTAMPTZ,
        "finished_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sweater_transform_jobs_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sweater_transform_jobs_job_id" UNIQUE ("job_id")
      )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_sweater_header_templates_user_id_users_id') THEN
          ALTER TABLE "sweater_header_templates"
          ADD CONSTRAINT "FK_sweater_header_templates_user_id_users_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_sweater_transform_jobs_user_id_users_id') THEN
          ALTER TABLE "sweater_transform_jobs"
          ADD CONSTRAINT "FK_sweater_transform_jobs_user_id_users_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_sweater_transform_jobs_template_id_sweater_header_templates_id') THEN
          ALTER TABLE "sweater_transform_jobs"
          ADD CONSTRAINT "FK_sweater_transform_jobs_template_id_sweater_header_templates_id"
          FOREIGN KEY ("template_id") REFERENCES "sweater_header_templates"("id") ON DELETE RESTRICT;
        END IF;
      END$$;
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_sweater_header_templates_user_name" ON "sweater_header_templates" ("user_id", "name") WHERE "is_active" = true`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_sweater_header_templates_user_active" ON "sweater_header_templates" ("user_id", "is_active")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_sweater_transform_jobs_user_created" ON "sweater_transform_jobs" ("user_id", "created_at" DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_sweater_transform_jobs_status" ON "sweater_transform_jobs" ("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "idx_sweater_transform_jobs_status"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_sweater_transform_jobs_user_created"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_sweater_header_templates_user_active"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_sweater_header_templates_user_name"');
    await queryRunner.query('ALTER TABLE "sweater_transform_jobs" DROP CONSTRAINT IF EXISTS "FK_sweater_transform_jobs_template_id_sweater_header_templates_id"');
    await queryRunner.query('ALTER TABLE "sweater_transform_jobs" DROP CONSTRAINT IF EXISTS "FK_sweater_transform_jobs_user_id_users_id"');
    await queryRunner.query('ALTER TABLE "sweater_header_templates" DROP CONSTRAINT IF EXISTS "FK_sweater_header_templates_user_id_users_id"');
    await queryRunner.query('DROP TABLE IF EXISTS "sweater_transform_jobs"');
    await queryRunner.query('DROP TABLE IF EXISTS "sweater_header_templates"');
  }
}
