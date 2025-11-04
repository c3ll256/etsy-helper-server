import { MigrationInterface, QueryRunner } from 'typeorm';

// Change orders.orderType from enum to varchar(32) to avoid manual database enum updates
export class ChangeOrderTypeToVarchar1750000000003 implements MigrationInterface {
  name = 'ChangeOrderTypeToVarchar1750000000003'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop default to allow type change
    await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "orderType" DROP DEFAULT`);

    // If column is enum, we need to cast it to text first before changing to varchar
    // Try enum path safely by checking information_schema
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'orders'
          AND column_name = 'orderType'
          AND udt_name LIKE '%enum%'
      ) THEN
        ALTER TABLE "orders" ALTER COLUMN "orderType" TYPE varchar(32) USING ("orderType"::text);
      ELSE
        ALTER TABLE "orders" ALTER COLUMN "orderType" TYPE varchar(32);
      END IF;
    END $$;`);

    // Restore default
    await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "orderType" SET DEFAULT 'manual'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort revert to enum type
    await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "orderType" DROP DEFAULT`);
    
    // Try to recreate enum type if it doesn't exist
    await queryRunner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'orders_ordertype_enum') THEN
        CREATE TYPE "orders_ordertype_enum" AS ENUM ('etsy', 'manual', 'other');
      END IF;
    END $$;`);
    
    await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "orderType" TYPE "orders_ordertype_enum" USING ("orderType"::text::orders_ordertype_enum)`);
    await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "orderType" SET DEFAULT 'manual'`);
  }
}

