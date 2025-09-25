import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobIdToBasketGenerationRecords1750000000002 implements MigrationInterface {
  name = 'AddJobIdToBasketGenerationRecords1750000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "basket_generation_records" ADD COLUMN IF NOT EXISTS "jobId" character varying'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "basket_generation_records" DROP COLUMN IF EXISTS "jobId"'
    );
  }
}

