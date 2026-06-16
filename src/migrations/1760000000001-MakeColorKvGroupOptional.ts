import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeColorKvGroupOptional1760000000001 implements MigrationInterface {
  name = 'MakeColorKvGroupOptional1760000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "color_kv" ALTER COLUMN "group_id" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "color_kv" DROP CONSTRAINT IF EXISTS "FK_color_kv_group_id_color_groups_id"');
    await queryRunner.query(`
      ALTER TABLE "color_kv"
      ADD CONSTRAINT "FK_color_kv_group_id_color_groups_id"
      FOREIGN KEY ("group_id") REFERENCES "color_groups"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "color_kv" DROP CONSTRAINT IF EXISTS "FK_color_kv_group_id_color_groups_id"');
    await queryRunner.query(`
      ALTER TABLE "color_kv"
      ADD CONSTRAINT "FK_color_kv_group_id_color_groups_id"
      FOREIGN KEY ("group_id") REFERENCES "color_groups"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query('ALTER TABLE "color_kv" ALTER COLUMN "group_id" SET NOT NULL');
  }
}
