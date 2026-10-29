/**
 * 按《母婴模块优化需求》附表「名字排版基准」给 SKU 配置写入名字安全区 / 字号初值。
 *
 * 只写入附表已经给出数值的项目；附表写"校准 / 按对应 SKU 区域 / 需确认"的部分不填区域，
 * 生成时页面显示"名字区域未确认"。已经有 name_layout 的配置不会被覆盖。
 * SKU 属于哪一类是按 SKU 和显示名（replaceValue）的关键词判断的，判断规则见 classify()，
 * 写入的值都带 presetKey 且 confirmed=false，需要甲方逐个确认（审核页 / 明细页会显示提示）。
 *
 *   npx ts-node --transpile-only -P tsconfig.json scripts/basket-seed-name-layout.ts            # 只打印（默认）
 *   npx ts-node --transpile-only -P tsconfig.json scripts/basket-seed-name-layout.ts --apply    # 写入 .env 指向的数据库
 */
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

export const APPENDIX_PRESETS: Record<string, { label: string; layout: any }> = {
  backpack: { label: '普通书包', layout: { area: { x1: 11, x2: 91, y1: 20, y2: 89 }, maxFontSize: 275 } },
  backpack_set: { label: '套组书包', layout: { area: { x1: 11, x2: 91, y1: 20, y2: 89 }, maxFontSize: 275 } },
  backpack_pink1: { label: 'Pink1 普通书包（按具体 SKU 绑定）', layout: { area: { x1: 11, x2: 91, y1: 30, y2: 89 }, maxFontSize: 300 } },
  basket_m: { label: 'M 篮子', layout: { area: { x1: 0, x2: 100, y1: 29, y2: 82 }, maxFontSize: 275 } },
  // 以下附表只给了字号 / 限制，没有给区域：不填区域
  basket_l: { label: 'L 篮子（区域待校准，最小字号待确认）', layout: { maxFontSize: 300 } },
  basket_xl: { label: 'XL 及更大篮子（区域待校准，双行规则待确认）', layout: { maxFontSize: 330 } },
  basket_s: { label: '小篮子（区域待校准）', layout: { maxFontSize: 265 } },
  small_backpack: { label: '小书包（区域按 SKU 校准）', layout: { maxFontSize: 220, minFontSize: 152, preferredFontSize: 175, maxLatinLetters: 10 } },
  stationery04: { label: '文具04（区域按 SKU 校准）', layout: { maxFontSize: 220, minFontSize: 200, allowTwoLines: false, maxLatinLetters: 10 } },
  // 餐包：附表"最小字号 150 或 200 的旧规则冲突需确认"，所以不填最小字号
  lunch_bag: { label: '餐包（预留 10pt 缓冲，最小字号待确认）', layout: { area: { x1: 15, x2: 88, y1: 36, y2: 81 }, maxFontSize: 275, bufferPt: 10 } },
};

export function classify(sku: string, replaceValue: string): string | null {
  const s = sku || '';
  const r = replaceValue || '';
  if (s === 'Bag-Pink1(I)' || s === 'Bag-Pink1') return 'backpack_pink1';
  if (/文具\s*0?4/.test(r)) return 'stationery04';
  const hasLunch = /餐包/.test(r);
  const hasBackpack = /书包|^[一-龥]+\d(\(I\))?$/.test(r);
  if (hasLunch && hasBackpack) return null; // 单个配置里同时写了书包和餐包：不知道是哪一件，不填
  if (hasLunch) return 'lunch_bag';
  if (/小书包/.test(r)) return 'small_backpack';
  if (/书包/.test(r)) return 'backpack';
  if (/篮/.test(r) || /basket/i.test(s)) {
    if (/中号|M篮|灰色M$|[-\s]M$/.test(r) || /-M(\b|\(|$)/.test(s)) return 'basket_m';
    if (/XL|特大|加大/.test(r) || /-X{1,2}L\d?(\b|\(|$)/i.test(s)) return 'basket_xl';
    if (/大号|L篮/.test(r) || /-L(\b|\(|$)/.test(s)) return 'basket_l';
    if (/小号|小篮/.test(r) || /-S(\b|\(|$)/.test(s)) return 'basket_s';
  }
  return null;
}

function comboComponentPreset(item: string): string | null {
  if (/餐包/.test(item)) return 'lunch_bag';
  if (/笔袋/.test(item)) return null;
  if (/书包|^[一-龥]+\d$/.test(item)) return 'backpack_set';
  return null;
}

async function main() {
  require('dotenv').config({ path: path.join(ROOT, '.env'), override: true });
  const apply = process.argv.includes('--apply');
  const { Client } = require('pg');
  const client = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD || undefined, database: process.env.DB_NAME });
  await client.connect();
  const rows = (await client.query('select id, sku, type, "replaceValue", "comboItems", combo_overrides_json, name_layout from sku_configs order by id')).rows;
  const counts: Record<string, number> = {};
  let updated = 0;
  for (const row of rows) {
    if (row.type === 'combo') {
      const items: string[] = row.comboItems || [];
      const overrides = { ...(row.combo_overrides_json || {}) };
      let changed = false;
      for (const item of items) {
        const key = comboComponentPreset(item);
        if (!key || overrides[item]?.nameLayout) continue;
        overrides[item] = { ...(overrides[item] || {}), nameLayout: { ...APPENDIX_PRESETS[key].layout, presetKey: `appendix:${key}`, confirmed: false } };
        counts[`combo:${key}`] = (counts[`combo:${key}`] || 0) + 1;
        changed = true;
      }
      if (changed) {
        updated++;
        if (apply) await client.query('update sku_configs set combo_overrides_json = $1 where id = $2', [JSON.stringify(overrides), row.id]);
      }
      continue;
    }
    if (row.name_layout) continue;
    const key = classify(row.sku, row.replaceValue);
    if (!key) {
      counts.unclassified = (counts.unclassified || 0) + 1;
      continue;
    }
    counts[key] = (counts[key] || 0) + 1;
    updated++;
    if (apply) {
      await client.query('update sku_configs set name_layout = $1 where id = $2', [JSON.stringify({ ...APPENDIX_PRESETS[key].layout, presetKey: `appendix:${key}`, confirmed: false }), row.id]);
    }
  }
  await client.end();
  console.log(JSON.stringify({ apply, updated, counts }, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
