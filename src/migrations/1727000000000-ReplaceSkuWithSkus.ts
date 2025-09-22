import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReplaceSkuWithSkus1727000000000 implements MigrationInterface {
  name = 'ReplaceSkuWithSkus1727000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) Ensure skus column exists
    await queryRunner.query(`ALTER TABLE stamp_templates ADD COLUMN IF NOT EXISTS skus text[] NULL`);

    // 2) Backfill skus from sku if needed (if sku column still exists)
    await queryRunner.query(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='stamp_templates' AND column_name='sku'
      ) THEN
        UPDATE stamp_templates SET skus = ARRAY[sku] WHERE skus IS NULL;
      END IF;
    END $$;`);

    // 3) Drop sku column if it exists
    await queryRunner.query(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='stamp_templates' AND column_name='sku'
      ) THEN
        ALTER TABLE stamp_templates DROP COLUMN sku;
      END IF;
    END $$;`);

    // 4) Create GIN index on skus
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_stamp_templates_skus_gin ON stamp_templates USING gin (skus)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1) Recreate sku column
    await queryRunner.query(`ALTER TABLE stamp_templates ADD COLUMN IF NOT EXISTS sku text`);

    // 2) Restore sku from first element of skus array where possible
    await queryRunner.query(`UPDATE stamp_templates SET sku = (CASE WHEN skus IS NOT NULL AND array_length(skus, 1) >= 1 THEN skus[1] ELSE NULL END)`);

    // 3) Drop index and skus column
    await queryRunner.query(`DROP INDEX IF EXISTS idx_stamp_templates_skus_gin`);
    await queryRunner.query(`ALTER TABLE stamp_templates DROP COLUMN IF EXISTS skus`);
  }
}
