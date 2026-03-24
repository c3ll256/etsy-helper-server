import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderTypeToUploadJobs1710681284000 implements MigrationInterface {
  name = 'AddOrderTypeToUploadJobs1710681284000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'order_upload_jobs'
        ) AND NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'order_upload_jobs'
            AND column_name = 'order_type'
        ) THEN
          ALTER TABLE "order_upload_jobs"
          ADD COLUMN "order_type" varchar(32) NOT NULL DEFAULT 'stamp';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_upload_jobs_order_type"
      ON "order_upload_jobs" ("order_type")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_order_upload_jobs_order_type"`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'order_upload_jobs'
            AND column_name = 'order_type'
        ) THEN
          ALTER TABLE "order_upload_jobs" DROP COLUMN "order_type";
        END IF;
      END $$;
    `);
  }
}
