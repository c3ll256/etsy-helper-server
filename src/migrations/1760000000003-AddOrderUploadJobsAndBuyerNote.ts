import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderUploadJobsAndBuyerNote1760000000003 implements MigrationInterface {
  name = 'AddOrderUploadJobsAndBuyerNote1760000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_upload_jobs" (
        "id" bigserial NOT NULL,
        "job_id" varchar NOT NULL,
        "user_id" uuid NOT NULL,
        "order_type" varchar(32) NOT NULL DEFAULT 'stamp',
        "shop_name" varchar NULL,
        "file_name" varchar NOT NULL,
        "status" varchar NOT NULL,
        "progress" numeric(5,2) NOT NULL DEFAULT 0,
        "total_rows" integer NOT NULL DEFAULT 0,
        "success_rows" integer NOT NULL DEFAULT 0,
        "failed_rows" integer NOT NULL DEFAULT 0,
        "error_message" text NULL,
        "report_path" varchar NULL,
        "started_at" timestamptz NULL,
        "finished_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_upload_jobs_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_order_upload_jobs_job_id" UNIQUE ("job_id"),
        CONSTRAINT "FK_order_upload_jobs_user_id_users_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_upload_job_items" (
        "id" bigserial NOT NULL,
        "job_id" varchar NOT NULL,
        "order_id" varchar NULL,
        "transaction_id" varchar NULL,
        "sku" varchar NULL,
        "status" varchar NOT NULL,
        "reason" text NULL,
        "detail_json" jsonb NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_upload_job_items_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_order_upload_job_items_job_id_order_upload_jobs_job_id"
          FOREIGN KEY ("job_id") REFERENCES "order_upload_jobs"("job_id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query('ALTER TABLE "etsy_orders" ADD COLUMN IF NOT EXISTS "buyer_note_raw" text');

    await queryRunner.query('ALTER TABLE "order_upload_jobs" ADD COLUMN IF NOT EXISTS "order_type" varchar(32) NOT NULL DEFAULT \'stamp\'');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_order_upload_jobs_user_created" ON "order_upload_jobs" ("user_id", "created_at" DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_order_upload_jobs_status" ON "order_upload_jobs" ("status")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_order_upload_jobs_order_type" ON "order_upload_jobs" ("order_type")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_order_upload_job_items_job_id" ON "order_upload_job_items" ("job_id")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_order_upload_job_items_status" ON "order_upload_job_items" ("status")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_order_upload_job_items_order_id" ON "order_upload_job_items" ("order_id")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "idx_order_upload_job_items_order_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_order_upload_job_items_status"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_order_upload_job_items_job_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_order_upload_jobs_order_type"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_order_upload_jobs_status"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_order_upload_jobs_user_created"');
    await queryRunner.query('ALTER TABLE "etsy_orders" DROP COLUMN IF EXISTS "buyer_note_raw"');
    await queryRunner.query('DROP TABLE IF EXISTS "order_upload_job_items"');
    await queryRunner.query('DROP TABLE IF EXISTS "order_upload_jobs"');
  }
}
