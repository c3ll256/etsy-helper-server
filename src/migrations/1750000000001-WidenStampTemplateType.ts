import { MigrationInterface, QueryRunner } from 'typeorm';

// Widen stamp_templates.type to varchar(32) from enum or varchar(6)
export class WidenStampTemplateType1750000000001 implements MigrationInterface {
  name = 'WidenStampTemplateType1750000000001'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop default to allow type change
    await queryRunner.query(`ALTER TABLE "stamp_templates" ALTER COLUMN "type" DROP DEFAULT`);

    // If column is enum, we need to cast it to text first before changing to varchar
    // Try enum path safely by checking information_schema
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'stamp_templates'
          AND column_name = 'type'
          AND udt_name LIKE '%enum%'
      ) THEN
        ALTER TABLE "stamp_templates" ALTER COLUMN "type" TYPE varchar(32) USING ("type"::text);
      ELSE
        ALTER TABLE "stamp_templates" ALTER COLUMN "type" TYPE varchar(32);
      END IF;
    END $$;`);

    // Restore default
    await queryRunner.query(`ALTER TABLE "stamp_templates" ALTER COLUMN "type" SET DEFAULT 'rubber'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort revert to varchar(6) to match previous length, keeping default
    await queryRunner.query(`ALTER TABLE "stamp_templates" ALTER COLUMN "type" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "stamp_templates" ALTER COLUMN "type" TYPE varchar(6)`);
    await queryRunner.query(`ALTER TABLE "stamp_templates" ALTER COLUMN "type" SET DEFAULT 'rubber'`);
  }
}


