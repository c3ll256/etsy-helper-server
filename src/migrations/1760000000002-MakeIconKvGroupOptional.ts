import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeIconKvGroupOptional1760000000002 implements MigrationInterface {
  name = 'MakeIconKvGroupOptional1760000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "icon_kv" ALTER COLUMN "group_id" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "icon_kv" DROP CONSTRAINT IF EXISTS "FK_icon_kv_group_id_icon_groups_id"');
    await queryRunner.query(`
      ALTER TABLE "icon_kv"
      ADD CONSTRAINT "FK_icon_kv_group_id_icon_groups_id"
      FOREIGN KEY ("group_id") REFERENCES "icon_groups"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "icon_kv" DROP CONSTRAINT IF EXISTS "FK_icon_kv_group_id_icon_groups_id"');
    await queryRunner.query(`
      ALTER TABLE "icon_kv"
      ADD CONSTRAINT "FK_icon_kv_group_id_icon_groups_id"
      FOREIGN KEY ("group_id") REFERENCES "icon_groups"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query('ALTER TABLE "icon_kv" ALTER COLUMN "group_id" SET NOT NULL');
  }
}
