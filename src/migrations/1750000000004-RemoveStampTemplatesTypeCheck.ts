import { MigrationInterface, QueryRunner } from 'typeorm';

// Remove check constraint on stamp_templates.type to allow new stamp types without manual database updates
export class RemoveStampTemplatesTypeCheck1750000000004 implements MigrationInterface {
  name = 'RemoveStampTemplatesTypeCheck1750000000004'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the check constraint if it exists
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'stamp_templates_type_check'
          AND table_name = 'stamp_templates'
      ) THEN
        ALTER TABLE "stamp_templates" DROP CONSTRAINT "stamp_templates_type_check";
      END IF;
    END $$;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Note: We cannot recreate the exact check constraint without knowing all the original values
    // This is intentional - once removed, we rely on TypeScript enum validation instead
    // If you need to restore it, you would need to manually add back the constraint with all values
  }
}

