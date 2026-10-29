/**
 * 本地开发用：初始化一个空数据库。
 *
 * 现有 migrations 假设基础表已存在（早期用 synchronize 建表），在空库上无法直接运行。
 * 本脚本先按实体 synchronize 建表，再把全部 migration 记为已执行，
 * 之后正常 `npm run dev` 时 migrationsRun 不会重复执行它们。
 *
 * 仅限本地空库使用，禁止对生产库运行。
 * 用法：npx ts-node scripts/dev-bootstrap-db.ts
 */
import 'reflect-metadata';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function bootstrap() {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    entities: [path.join(__dirname, '..', 'src', '**', '*.entity.ts')],
    synchronize: false,
  });
  await dataSource.initialize();

  const [{ count }] = await dataSource.query(
    `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  if (count > 0) {
    console.error(`数据库 ${process.env.DB_NAME} 不是空库（已有 ${count} 张表），已中止。`);
    await dataSource.destroy();
    process.exit(1);
  }

  await dataSource.synchronize();

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS "migrations" (
      "id" SERIAL PRIMARY KEY,
      "timestamp" bigint NOT NULL,
      "name" varchar NOT NULL
    )
  `);

  const migrationDir = path.join(__dirname, '..', 'src', 'migrations');
  const files = fs.readdirSync(migrationDir).filter((f) => f.endsWith('.ts')).sort();
  for (const file of files) {
    const source = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    const className = source.match(/export class (\w+)/)?.[1];
    const timestamp = file.split('-')[0];
    if (!className) continue;
    await dataSource.query(`INSERT INTO "migrations" ("timestamp", "name") VALUES ($1, $2)`, [timestamp, className]);
  }

  console.log(`已建表，并标记 ${files.length} 个 migration 为已执行。`);
  await dataSource.destroy();
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
