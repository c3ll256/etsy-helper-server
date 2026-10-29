/**
 * 母婴流水线命令行：Excel → 明细分析 → 布局计划 → PPT，输出结构化报告（供回归用例和真实数据批跑使用）。
 *
 * 用法（在 etsy-helper-server 目录下）：
 *   npx ts-node --transpile-only -P tsconfig.json scripts/regression/basket_pipeline_cli.ts \
 *       --excel input.xlsx --fixture fixture.json [--out out.pptx] [--report report.json] [--no-render]
 *   npx ts-node --transpile-only -P tsconfig.json scripts/regression/basket_pipeline_cli.ts \
 *       --excel input.xlsx --db-user <userId> [--order-type all] ...      # 从 .env 指向的数据库读取该账号的配置
 *
 * fixture.json 结构见 cases/basket/_fixture.json。
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildLineDrafts, PipelineContext, readExcelRows } from '../../src/basket/pipeline/line-pipeline';
import { runPipeline } from '../../src/basket/pipeline/run-pipeline';
import { runPythonGenerator } from '../../src/basket/pipeline/python-runner';
import { DEFAULT_SHOP_SETTINGS, LayoutTemplateLike } from '../../src/basket/pipeline/types';

const ROOT = path.resolve(__dirname, '..', '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function exists(p: string): boolean {
  if (!p) return false;
  const rel = p.startsWith('/uploads') ? p.slice(1) : p;
  return fs.existsSync(path.isAbsolute(rel) && fs.existsSync(rel) ? rel : path.join(ROOT, rel));
}

export function contextFromFixture(fixture: any): { ctx: PipelineContext; meta: { shopName: string; processDate: string } } {
  const iconGroups = new Map<number, any[]>();
  for (const [gid, list] of Object.entries<any[]>(fixture.iconGroups || {})) {
    iconGroups.set(Number(gid), list.map((e) => ({ kind: 'large', ...e, fileExists: e.fileExists ?? exists(e.filePath) })));
  }
  const colorGroups = new Map<number, any[]>();
  for (const [gid, list] of Object.entries<any[]>(fixture.colorGroups || {})) colorGroups.set(Number(gid), list);
  const layoutTemplates = new Map<number, LayoutTemplateLike>();
  for (const t of fixture.layoutTemplates || []) layoutTemplates.set(Number(t.id), t);
  const fonts = (fixture.fonts || []).map((f: any) => ({ ...f, fileExists: exists(f.filePath) }));
  return {
    ctx: {
      configs: fixture.configs || [],
      iconGroups,
      colorGroups,
      layoutTemplates,
      fonts,
      settings: { ...DEFAULT_SHOP_SETTINGS, ...(fixture.settings || {}) },
      orderTypeScope: fixture.orderTypeScope || 'all',
      llm: null,
    },
    meta: { shopName: fixture.shopName || 'TestShop', processDate: fixture.processDate || '2026-10-29' },
  };
}

async function contextFromDb(userId: string, orderType: string): Promise<{ ctx: PipelineContext; meta: { shopName: string; processDate: string } }> {
  require('dotenv').config({ path: path.join(ROOT, '.env'), override: true });
  const { Client } = require('pg');
  const client = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || undefined, database: process.env.DB_NAME,
  });
  await client.connect();
  try {
    const user = (await client.query('select id, "shopName" from users where id = $1', [userId])).rows[0];
    const configs = (await client.query('select * from sku_configs where "userId" = $1', [userId])).rows.map((r: any) => ({
      id: r.id, userId: r.userId, sku: r.sku, type: r.type, replaceValue: r.replaceValue, fontSize: r.fontSize, font: r.font,
      yarnColorMap: r.yarnColorMap, comboItems: r.comboItems, colorGroupId: r.color_group_id ? Number(r.color_group_id) : null,
      iconGroupId: r.icon_group_id ? Number(r.icon_group_id) : null, comboOverridesJson: r.combo_overrides_json,
      externalOrderReminderEnabled: r.externalOrderReminderEnabled, externalOrderReminderContent: r.externalOrderReminderContent,
      produceMode: r.produce_mode || 'ppt', iconLayoutTemplateId: r.icon_layout_template_id, maxIcons: r.max_icons, nameLayout: r.name_layout,
    }));
    const iconRows = (await client.query('select k.* from icon_kv k where k.is_active and k.group_id is not null')).rows;
    const iconGroups = new Map<number, any[]>();
    for (const r of iconRows) {
      const g = Number(r.group_id);
      if (!iconGroups.has(g)) iconGroups.set(g, []);
      iconGroups.get(g)!.push({ id: Number(r.id), name: r.name, code: r.code, aliases: r.aliases, kind: r.kind || 'large', filePath: r.file_path, fileExists: exists(r.file_path) });
    }
    const colorRows = (await client.query('select * from color_kv where is_active and group_id is not null')).rows;
    const colorGroups = new Map<number, any[]>();
    for (const r of colorRows) {
      const g = Number(r.group_id);
      if (!colorGroups.has(g)) colorGroups.set(g, []);
      colorGroups.get(g)!.push({ name: r.name, colorValue: r.color_value });
    }
    let templates: any[] = [];
    try {
      templates = (await client.query('select * from basket_icon_layout_templates where is_active')).rows;
    } catch {}
    const layoutTemplates = new Map<number, LayoutTemplateLike>(templates.map((t: any) => [t.id, { id: t.id, name: t.name, slots: t.slots, rules: t.rules, defaultOrder: t.default_order }]));
    const fonts = (await client.query('select id, name, "filePath" from fonts where "isActive"')).rows.map((r: any) => ({ id: r.id, name: r.name, filePath: r.filePath, fileExists: exists(r.filePath) }));
    let settings = {};
    try {
      settings = (await client.query('select settings from basket_shop_settings where user_id = $1', [userId])).rows[0]?.settings || {};
    } catch {}
    return {
      ctx: { configs, iconGroups, colorGroups, layoutTemplates, fonts, settings: { ...DEFAULT_SHOP_SETTINGS, ...settings }, orderTypeScope: orderType, llm: null },
      meta: { shopName: user?.shopName || '', processDate: new Date().toISOString().slice(0, 10) },
    };
  } finally {
    await client.end();
  }
}

export async function runOnce(excelPath: string, ctxMeta: { ctx: PipelineContext; meta: any }, render: boolean) {
  const rows = readExcelRows(fs.readFileSync(excelPath));
  const lines = buildLineDrafts(rows);
  const python = (req: any) => runPythonGenerator(req, { pythonExecutable: path.join(ROOT, '.venv', 'bin', 'python'), cwd: ROOT });
  return runPipeline(lines, ctxMeta.ctx, ctxMeta.meta, python, { render });
}

export function summarize(output: any) {
  return {
    stats: output.stats,
    lines: output.lines.map((l: any) => ({
      rowIndex: l.rowIndex,
      orderId: l.orderId,
      sku: l.sku,
      quantity: l.quantity,
      status: l.status,
      matchStatus: l.matchStatus,
      matchedSku: l.matchedSku,
      exceptionCategory: l.exceptionCategory,
      reasons: l.reasons.map((r: any) => `${r.code}: ${r.message}`),
      warnings: l.warnings.map((r: any) => `${r.code}: ${r.message}`),
      duplicateOf: l.duplicateOfRowIndex,
      reminderText: l.reminderText,
      orderHasPages: l.orderHasPages,
      noteRaw: l.noteRaw,
      parse: l.parse && { format: l.parse.format, source: l.parse.source, fields: l.parse.fields, colorRaw: l.parse.colorRaw, attachments: l.parse.attachments, items: l.parse.items.map((i: any) => ({ name: i.name, icons: i.icons.map((x: any) => x.iconName), component: i.component })) },
      units: l.units.map((u: any) => ({
        key: u.unitKey, component: u.component, name: u.name, icons: u.icons.map((i: any) => ({ name: i.iconName, slot: i.slot?.key, position: i.position })),
        colorRaw: u.colorRaw, colorMapped: u.colorMapped, groupPosition: u.groupPosition, slideNumber: u.slideNumber, render: u.render,
      })),
      producedSlides: l.producedSlides,
    })),
    slides: output.slides.map((s: any, i: number) => ({ n: i + 1, kind: s.kind, key: s.key, title: s.title, groupPosition: s.groupPosition, globalNumber: s.globalNumber, reminder: s.reminder, warnings: s.warnings })),
    reports: output.reports.map((r: any) => ({ key: r.key, iconsExpected: r.iconsExpected, iconsInserted: r.iconsInserted, nameRendered: r.nameRendered, error: r.error })),
  };
}

async function main() {
  const excel = arg('--excel');
  if (!excel) {
    console.error('缺少 --excel');
    process.exit(2);
  }
  const fixturePath = arg('--fixture');
  const dbUser = arg('--db-user');
  const ctxMeta = fixturePath
    ? contextFromFixture(JSON.parse(fs.readFileSync(fixturePath, 'utf8')))
    : await contextFromDb(dbUser!, arg('--order-type') || 'all');
  const render = !process.argv.includes('--no-render');
  const output = await runOnce(excel, ctxMeta, render);
  const out = arg('--out');
  if (out && output.pptBase64) fs.writeFileSync(out, Buffer.from(output.pptBase64, 'base64'));
  const report = summarize(output);
  const reportPath = arg('--report');
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
}
