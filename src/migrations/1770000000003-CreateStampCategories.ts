import { MigrationInterface, QueryRunner } from 'typeorm';

const SEED: Array<[string, string, boolean]> = [
  ['rubber', '橡胶印章', false],
  ['steel', '钢印', false],
  ['rubber_pad_circle', '胶垫-圆形', false],
  ['rubber_pad_rectangle', '胶垫-长方形', false],
  ['steel_zhuoda', '钢印-卓达', false],
  ['steel_copper', '钢印-铜片', false],
  ['photo', '光敏印章', false],
  ['photo_egg', '光敏鸡蛋', false],
  ['photo_golf', '光敏高尔夫', false],
  ['photo_clothes', '光敏衣服', false],
  ['golf_set', '高尔夫套装', false],
  ['wax_seal', '火漆印章', false],
  ['acryl', '亚克力印章', false],
  ['rattle', '摇铃', true],
];

export class CreateStampCategories1770000000003 implements MigrationInterface {
  name = 'CreateStampCategories1770000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "stamp_categories" (
        "id" SERIAL PRIMARY KEY,
        "code" VARCHAR(32) NOT NULL UNIQUE,
        "name" VARCHAR(64) NOT NULL,
        "sortOrder" INTEGER NOT NULL DEFAULT 0,
        "isSystem" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE
      )
    `);
    // 原有固定类型作为初始分类，顺序与原下拉框一致
    for (let i = 0; i < SEED.length; i++) {
      const [code, name, isSystem] = SEED[i];
      await queryRunner.query(
        `INSERT INTO "stamp_categories" ("code", "name", "sortOrder", "isSystem") VALUES ($1, $2, $3, $4) ON CONFLICT ("code") DO NOTHING`,
        [code, name, i * 10, isSystem],
      );
    }
    // 现有模板里出现但不在初始列表中的类型，也补成分类，避免模板失去归属
    await queryRunner.query(`
      INSERT INTO "stamp_categories" ("code", "name", "sortOrder")
      SELECT DISTINCT t."type", t."type", 1000 FROM "stamp_templates" t
      WHERE t."type" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "stamp_categories" c WHERE c."code" = t."type")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "stamp_categories"');
  }
}
