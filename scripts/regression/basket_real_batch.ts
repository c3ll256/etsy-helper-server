/**
 * 真实数据批跑（只在本机使用，输入是生产快照里的原始上传 Excel，含顾客数据，结果不要提交）。
 *
 *   npx ts-node --transpile-only -P tsconfig.json scripts/regression/basket_real_batch.ts \
 *       --dir ~/Repos/etsy-helper/.dev/snapshots/prod-excel --count 300 [--render-every 10] [--out-dir /tmp/batch]
 *
 * 每个文件按上传时间戳对应到 basket_generation_records，取上传账号的 SKU 配置和上传时选的订单类型，
 * 跑完整流水线（布局计划用真实字体测量）；每隔 N 个文件完整渲染一次 PPT 并做几何检查（越界、重叠）。
 * 输出：崩溃数、待核对率、未匹配率、异常类别分布、最常见原因。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildLineDrafts, readExcelRows } from '../../src/basket/pipeline/line-pipeline';
import { runPipeline } from '../../src/basket/pipeline/run-pipeline';
import { runPythonGenerator } from '../../src/basket/pipeline/python-runner';
import { DEFAULT_SHOP_SETTINGS } from '../../src/basket/pipeline/types';

const ROOT = path.resolve(__dirname, '..', '..');

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function exists(p: string): boolean {
  if (!p) return false;
  const rel = p.startsWith('/') ? p.slice(1) : p;
  return fs.existsSync(path.join(ROOT, rel));
}

async function main() {
  require('dotenv').config({ path: path.join(ROOT, '.env'), override: true });
  const { Client } = require('pg');
  const client = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD || undefined, database: process.env.DB_NAME });
  await client.connect();
  const dir = arg('--dir')!.replace(/^~/, process.env.HOME || '');
  const count = Number(arg('--count', '300'));
  const renderEvery = Number(arg('--render-every', '10'));
  const outDir = arg('--out-dir');
  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  const records = (await client.query(`select id, "userId", "orderType", (extract(epoch from "createdAt")*1000)::bigint as ts from basket_generation_records`)).rows
    .map((r: any) => ({ ...r, ts: Number(r.ts) })).sort((a: any, b: any) => a.ts - b.ts);
  const files = fs.readdirSync(dir).filter((f) => /^file-\d+/.test(f)).sort();
  // 均匀抽样：覆盖不同时期、不同账号
  const step = Math.max(1, Math.floor(files.length / count));
  const picked = files.filter((_, i) => i % step === 0).slice(0, count);

  const iconRows = (await client.query('select * from icon_kv where is_active and group_id is not null')).rows;
  const iconGroups = new Map<number, any[]>();
  for (const r of iconRows) {
    const g = Number(r.group_id);
    if (!iconGroups.has(g)) iconGroups.set(g, []);
    iconGroups.get(g)!.push({ id: Number(r.id), name: r.name, code: r.code, aliases: r.aliases, kind: r.kind || 'large', filePath: r.file_path, fileExists: exists(r.file_path) });
  }
  const colorGroups = new Map<number, any[]>();
  for (const r of (await client.query('select * from color_kv where is_active and group_id is not null')).rows) {
    const g = Number(r.group_id);
    if (!colorGroups.has(g)) colorGroups.set(g, []);
    colorGroups.get(g)!.push({ name: r.name, colorValue: r.color_value });
  }
  const fonts = (await client.query('select id, name, "filePath" from fonts where "isActive"')).rows.map((r: any) => ({ id: r.id, name: r.name, filePath: r.filePath, fileExists: exists(r.filePath) }));
  const templates = (await client.query('select * from basket_icon_layout_templates where is_active')).rows;
  const layoutTemplates = new Map<number, any>(templates.map((t: any) => [t.id, { id: t.id, name: t.name, slots: t.slots, rules: t.rules, defaultOrder: t.default_order }]));
  const configCache = new Map<string, any[]>();
  const loadConfigs = async (userId: string) => {
    if (!configCache.has(userId)) {
      const rows = (await client.query('select * from sku_configs where "userId" = $1', [userId])).rows;
      configCache.set(userId, rows.map((r: any) => ({
        id: r.id, userId: r.userId, sku: r.sku, type: r.type, replaceValue: r.replaceValue, fontSize: r.fontSize, font: r.font, yarnColorMap: r.yarnColorMap,
        comboItems: r.comboItems, colorGroupId: r.color_group_id ? Number(r.color_group_id) : null, iconGroupId: r.icon_group_id ? Number(r.icon_group_id) : null,
        comboOverridesJson: r.combo_overrides_json, externalOrderReminderEnabled: r.externalOrderReminderEnabled, externalOrderReminderContent: r.externalOrderReminderContent,
        produceMode: r.produce_mode || 'ppt', iconLayoutTemplateId: r.icon_layout_template_id, maxIcons: r.max_icons, nameLayout: r.name_layout,
      })));
    }
    return configCache.get(userId)!;
  };

  const python = (req: any) => runPythonGenerator(req, { pythonExecutable: path.join(ROOT, '.venv', 'bin', 'python'), cwd: ROOT });
  const totals: any = { files: 0, unmappedFiles: 0, crashes: 0, lines: 0, duplicates: 0, produced: 0, units: 0, review: 0, failed: 0, unmatched: 0, conflict: 0, external: 0, outOfScope: 0, ignored: 0, prefixMatches: 0, rendered: 0, geometryFailures: 0, ordersNoPages: 0 };
  const categories: Record<string, number> = {};
  const reasonCodes: Record<string, number> = {};
  const warningCodes: Record<string, number> = {};
  const crashes: string[] = [];
  const samplesPath = arg('--samples');
  const samples: Record<string, any[]> = {};
  const geometry: string[] = [];
  const started = Date.now();

  for (let i = 0; i < picked.length; i++) {
    const file = picked[i];
    const ts = Number(file.split('-')[1]);
    let best: any = null;
    let bestD = Infinity;
    for (const r of records) {
      const d = r.ts - ts;
      if (d >= -2000 && Math.abs(d) < bestD) { bestD = Math.abs(d); best = r; }
    }
    if (!best || bestD > 10000 || !best.userId) { totals.unmappedFiles++; continue; }
    totals.files++;
    try {
      const configs = await loadConfigs(best.userId);
      const settings = { ...DEFAULT_SHOP_SETTINGS };
      const orderType = best.orderType === 'basket' || best.orderType === 'backpack' || !best.orderType ? 'all' : best.orderType;
      const ctx = { configs, iconGroups, colorGroups, layoutTemplates, fonts, settings, orderTypeScope: orderType, llm: null };
      const lines = buildLineDrafts(readExcelRows(fs.readFileSync(path.join(dir, file))));
      const render = renderEvery > 0 && i % renderEvery === 0;
      const output = await runPipeline(lines, ctx as any, { shopName: 'batch', processDate: '2026-10-29' }, python, { render });
      const orders = new Map<string, boolean>();
      for (const l of output.lines) {
        totals.lines++;
        const key = { produced: 'produced', review: 'review', failed: 'failed', unmatched: 'unmatched', conflict: 'conflict', duplicate: 'duplicates', external: 'external', out_of_scope: 'outOfScope', ignored: 'ignored' }[l.status];
        if (key) totals[key]++;
        if (l.status === 'produced') totals.units += l.producedUnits;
        if (l.matchStatus === 'prefix') totals.prefixMatches++;
        if (l.exceptionCategory) categories[l.exceptionCategory] = (categories[l.exceptionCategory] || 0) + 1;
        for (const r of l.reasons) if (r.severity === 'blocking') {
          reasonCodes[r.code] = (reasonCodes[r.code] || 0) + 1;
          if (samplesPath && r.code !== 'sku_unmatched') {
            const list = (samples[r.code] = samples[r.code] || []);
            if (list.length < 40 && Math.random() < 0.3) list.push({ sku: l.sku, q: l.quantity, v: l.variationsRaw, reason: r.message, items: l.parse?.items.map((it) => [it.name, it.icons.map((x) => x.iconName)]) });
          }
        }
        for (const r of l.warnings) warningCodes[r.code] = (warningCodes[r.code] || 0) + 1;
        if (l.orderId && l.status !== 'duplicate') orders.set(l.orderId, (orders.get(l.orderId) || false) || l.orderHasPages);
      }
      for (const l of output.lines) {
        if (l.warnings.some((w) => w.code === 'order_no_pages')) { /* counted below */ }
      }
      totals.ordersNoPages += new Set(output.lines.filter((l) => l.warnings.some((w) => w.code === 'order_no_pages')).map((l) => l.orderId)).size;
      if (render && output.pptBase64) {
        totals.rendered++;
        const pptPath = path.join(outDir || '/tmp', `${file}.pptx`);
        fs.writeFileSync(pptPath, Buffer.from(output.pptBase64, 'base64'));
        try {
          const res = execFileSync(path.join(ROOT, '.venv', 'bin', 'python'), ['-c', `
import json,sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts', 'regression'))})
from ppt_inspect import extract, check
print(json.dumps(check(extract(sys.argv[1]), {"allShapesInsideSlide": True, "noOverlap": True}), ensure_ascii=False))
`, pptPath]).toString();
          const fails = JSON.parse(res);
          if (fails.length) { totals.geometryFailures++; geometry.push(`${file}: ${fails.slice(0, 3).join('; ')}`); }
        } finally {
          if (!outDir) fs.unlinkSync(pptPath);
        }
      }
    } catch (e) {
      totals.crashes++;
      crashes.push(`${file}: ${(e as Error).message.slice(0, 300)}`);
    }
    if ((i + 1) % 25 === 0) console.error(`… ${i + 1}/${picked.length} 文件，${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  await client.end();
  if (samplesPath) fs.writeFileSync(samplesPath, JSON.stringify(samples, null, 1));
  const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + '%' : '-');
  const nonDup = totals.lines - totals.duplicates;
  const result = {
    totals,
    rates: {
      reviewRate: pct(totals.review, nonDup),
      failedRate: pct(totals.failed, nonDup),
      unmatchedRate: pct(totals.unmatched, nonDup),
      conflictRate: pct(totals.conflict, nonDup),
      producedRate: pct(totals.produced, nonDup),
      reviewAmongMatchedPpt: pct(totals.review, totals.review + totals.produced + totals.failed),
    },
    categories: Object.entries(categories).sort((a, b) => b[1] - a[1]),
    blockingReasonCodes: Object.entries(reasonCodes).sort((a, b) => b[1] - a[1]),
    warningCodes: Object.entries(warningCodes).sort((a, b) => b[1] - a[1]),
    crashes,
    geometry,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
