import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderTypeToUploadJobs1710681284000 implements MigrationInterface {
  name = 'AddOrderTypeToUploadJobs1710681284000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_upload_jobs"
      ADD COLUMN "order_type" varchar(32) NOT NULL DEFAULT 'stamp'
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_order_upload_jobs_order_type"
      ON "order_upload_jobs" ("order_type")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_order_upload_jobs_order_type"`);
    await queryRunner.query(`ALTER TABLE "order_upload_jobs" DROP COLUMN "order_type"`);
  }
}