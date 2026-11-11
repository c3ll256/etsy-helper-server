/**
 * 母婴 v2 接口端到端测试（本地开发服务器，默认 http://localhost:3081）。全部使用合成数据：
 * 建测试账号 → 建图标组 / 颜色组 / 布局模板 / SKU 配置 → 上传 Excel → 明细 / 异常清单 / 导出 →
 * 复制 SKU 修正未配置 → 重新解析 → 补处理生成 → 整条记录重新生成 → 参考图 → 人工指定 → 店铺开关 → 按类型上传
 *
 *   npx ts-node --transpile-only -P tsconfig.json scripts/regression/basket_api_e2e.ts [--base http://localhost:3081]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import * as XLSX from 'xlsx';
import * as AdmZip from 'adm-zip';

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i >= 0 ? process.argv[i + 1] : 'http://localhost:3081';
})();
const QA_USER = 'qa_basket_e2e';
const QA_PASS = 'qa-basket-e2e-pass';

let token = '';
const results: Array<{ step: string; ok: boolean; detail?: string }> = [];

async function api(method: string, url: string, body?: any, opts: { form?: boolean; raw?: boolean; expect?: number } = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: any;
  if (body !== undefined) {
    if (opts.form) payload = body;
    else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const res = await fetch(`${BASE}${url}`, { method, headers, body: payload });
  if (opts.expect !== undefined) {
    if (res.status !== opts.expect) throw new Error(`${method} ${url} 期望 ${opts.expect}，实际 ${res.status}: ${await res.text()}`);
  } else if (!res.ok) {
    throw new Error(`${method} ${url} → ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  if (opts.raw) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function sortedJson(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${k}:${sortedJson(v[k])}`).join(',')}}`;
}

function check(step: string, cond: boolean, detail?: any) {
  results.push({ step, ok: !!cond, detail: cond ? undefined : JSON.stringify(detail)?.slice(0, 400) });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${step}${cond ? '' : '  ' + JSON.stringify(detail)?.slice(0, 400)}`);
}

function icon(name: string) {
  return new Blob([new Uint8Array(fs.readFileSync(path.join(ROOT, 'scripts/regression/assets/icons', `${name}.png`)))], { type: 'image/png' });
}

function excel(rows: any[]): Blob {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return new Blob([new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

async function upload(rows: any[], orderType = 'all', name = 'e2e.xlsx') {
  const form = new FormData();
  form.append('file', excel(rows), name);
  form.append('originalFilename', name);
  form.append('orderType', orderType);
  const created = await api('POST', '/baskets/generate', form, { form: true });
  for (let i = 0; i < 120; i++) {
    const st = await api('GET', `/baskets/generate/${created.jobId}/status`);
    if (st.status === 'completed' || st.status === 'failed') return { ...st, recordId: created.id };
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('生成超时');
}

async function inspectZip(webPath: string, extra: Record<string, any> = {}): Promise<string[]> {
  const res = await api('GET', webPath, undefined, { raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const ppt = zip.getEntries().find((e) => e.entryName.endsWith('.pptx'));
  if (!ppt) return ['zip 里没有 pptx'];
  const tmp = path.join(os.tmpdir(), `e2e-${Date.now()}.pptx`);
  fs.writeFileSync(tmp, ppt.getData());
  const out = execFileSync(path.join(ROOT, '.venv/bin/python'), ['-c', `
import json,sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts/regression'))})
from ppt_inspect import extract, check
expect = {"allShapesInsideSlide": True, "noOverlap": True, **json.loads(sys.argv[2])}
print(json.dumps(check(extract(sys.argv[1]), expect), ensure_ascii=False))
`, tmp, JSON.stringify(extra)]).toString();
  fs.unlinkSync(tmp);
  return JSON.parse(out);
}

async function main() {
  // 1. 账号
  token = (await api('POST', '/users/login', { username: 'admin', password: 'admin123' })).access_token;
  try {
    await api('POST', '/users', { username: QA_USER, password: QA_PASS, isAdmin: false, shopName: 'QA-Basket' });
  } catch (e) {
    if (!String(e).includes('409') && !String(e).includes('exists') && !String(e).includes('已存在') && !String(e).includes('400')) throw e;
  }
  token = (await api('POST', '/users/login', { username: QA_USER, password: QA_PASS })).access_token;
  check('登录测试账号', !!token);

  // 2. 字典与模板
  const stamp = Date.now().toString().slice(-6);
  const group = await api('POST', '/baskets/icon-groups', { name: `e2e-icons-${stamp}`, productType: 'maternal_baby' });
  const icons: Record<string, any> = {};
  for (const [file, name] of [['A', 'A'], ['B', 'B'], ['ZF', 'ZF'], ['white-flower', 'White Flower'], ['bear', 'Bear']]) {
    const form = new FormData();
    form.append('file', icon(file), `${file}.png`);
    form.append('groupId', String(group.id));
    form.append('name', name);
    icons[name] = await api('POST', '/baskets/icon-kv/upload', form, { form: true });
  }
  const wf = await api('PUT', `/baskets/icon-kv/${icons['White Flower'].id}`, { kind: 'flower', aliases: 'weiße Blume, white flowers' });
  check('图标别名 / 类别保存', wf.kind === 'flower' && wf.aliases?.includes('weiße Blume'), wf);
  const colorGroup = await api('POST', '/baskets/color-groups', { name: `e2e-colors-${stamp}`, productType: 'maternal_baby' });
  await api('POST', '/baskets/color-kv/batch', { groupId: colorGroup.id, items: [{ name: 'Blue', colorValue: '蓝色' }, { name: 'Mix-2', colorValue: '混色2：蓝+白+浅粉' }] });
  const badTemplate = await api('POST', '/baskets/layout-templates', { name: 'bad', slots: [{ key: 'x', anchor: 'absolute', x: 90, y: 88, w: 9, h: 10 }], rules: [], defaultOrder: ['x'] }, { expect: 400 });
  check('布局模板校验：与二维码 / 页脚重叠的位置被拒绝', !!badTemplate, badTemplate);
  const template = await api('POST', '/baskets/layout-templates', {
    name: `右上左下型-${stamp}`,
    slots: [{ key: 'top_right', label: '右上', anchor: 'absolute', x: 78, y: 21, w: 16, h: 20 }, { key: 'bottom_left', label: '左下', anchor: 'absolute', x: 5, y: 62, w: 16, h: 20 }],
    rules: [],
    defaultOrder: ['top_right', 'bottom_left'],
  });
  check('新建图标布局模板', !!template.id, template);

  // 3. SKU 配置
  const cfg = (sku: string, extra: any = {}) => api('POST', '/baskets/sku-config', {
    sku, type: 'maternal_baby', font: 'Back to school', fontSize: 275, iconGroupId: Number(group.id), colorGroupId: Number(colorGroup.id), iconLayoutTemplateId: template.id,
    nameLayout: { area: { x1: 11, x2: 91, y1: 20, y2: 89 }, maxFontSize: 275, presetKey: 'appendix:backpack', confirmed: true }, ...extra,
  });
  const bagBlue = await cfg(`E2E-Bag-Blue-${stamp}`, { replaceValue: '蓝色书包' });
  const basketM = await cfg(`E2E-Basket-M-${stamp}`, { replaceValue: 'M篮子', nameLayout: { area: { x1: 0, x2: 100, y1: 29, y2: 82 }, maxFontSize: 275, confirmed: true } });
  await api('POST', '/baskets/sku-config', { sku: `E2E-Rattle-${stamp}`, type: 'maternal_baby', replaceValue: '摇铃', produceMode: 'external' });
  const combo = await api('POST', '/baskets/sku-config', {
    sku: `E2E-Set-${stamp}`, type: 'combo', font: 'Back to school', iconGroupId: Number(group.id), colorGroupId: Number(colorGroup.id), iconLayoutTemplateId: template.id,
    comboItems: ['蓝色书包', '蓝色餐包'],
    comboOverridesJson: { 蓝色餐包: { maxIcons: 2, nameLayout: { area: { x1: 15, x2: 88, y1: 36, y2: 81 }, maxFontSize: 275, bufferPt: 10 } } },
  });
  check('SKU 配置含新字段（布局模板 / 名字区域 / 生成方式）', bagBlue.iconLayoutTemplateId === template.id && bagBlue.nameLayout?.area?.x1 === 11 && combo.id, bagBlue);
  await api('POST', '/baskets/sku-config', { sku: `E2E-Bad-${stamp}`, type: 'maternal_baby', nameLayout: { area: { x1: 50, x2: 40, y1: 0, y2: 10 } } }, { expect: 400 });
  check('名字区域校验：x1 ≥ x2 被拒绝', true);

  // 4. 上传
  const S = stamp;
  const rows = [
    { 'Order ID': `9${S}01`, SKU: bagBlue.sku, Quantity: 2, Variations: 'Backpack ColorBlue\nYarn ColorBlue\nPersonalization\nEmily\nKara', Note: 'Please hurry\nthanks!', 'Date Paid': '10/25/2026' },
    { 'Order ID': `9${S}01`, SKU: `E2E-Rattle-${stamp}-Bunny`, Quantity: 2, Variations: 'Rattle Style02 Bunny\nPersonalizationEmily' },
    { 'Order ID': `9${S}01`, SKU: `E2E-NEW-${stamp}`, Quantity: 1, Variations: 'Bag ColorPink\nPersonalizationKalani', 'Item Name': 'New Storage Bag' },
    { 'Order ID': `9${S}02`, SKU: basketM.sku, Quantity: 1, Variations: 'Basket SizeM\nYarn ColorMix-2\nPersonalizationIan Parker, Bear, white flower, white flower' },
    { 'Order ID': `9${S}02`, SKU: basketM.sku, Quantity: 1, Variations: 'Basket SizeM\nYarn ColorMix-2\nPersonalizationIan Parker, Bear, white flower, white flower' },
    { 'Order ID': `9${S}03`, SKU: combo.sku, Quantity: 1, Variations: 'Set ColorBlue\nYarn ColorBlue\nPersonalizationLeo, A' },
    { 'Order ID': `9${S}04`, SKU: bagBlue.sku, Quantity: 1, Variations: 'Backpack ColorBlue\nYarn ColorBlue\nPersonalizationHudson, BDK' },
    { 'Order ID': `9${S}05`, SKU: `E2E-NEW-${stamp}`, Quantity: 1, Variations: 'Bag ColorPink\nPersonalizationSolo' },
  ];
  const job = await upload(rows);
  check('上传生成完成', job.status === 'completed', job);
  const recordId = job.recordId;
  const lines = (await api('GET', `/baskets/lines?recordId=${recordId}&limit=100`)).items;
  const byRow = (r: number) => lines.find((l: any) => l.rowIndex === r);
  check('明细落库：8 行（含重复行）', lines.length === 8, lines.length);
  check('Quantity=2 → 2 个制作单元，页码 1/2、2/2', byRow(2)?.producedUnits === 2 && byRow(2)?.units.map((u: any) => u.groupPosition).join(',') === '1/2,2/2', byRow(2)?.units);
  check('NOTE 原文（含换行）保存', byRow(2)?.noteRaw === 'Please hurry\nthanks!', byRow(2)?.noteRaw);
  check('连单提醒：摇铃×2 + 未配置新品（未生成）×1', byRow(2)?.reminderText === '连单：摇铃×2、New Storage Bag（未生成，待处理）×1', byRow(2)?.reminderText);
  check('正常连单（摇铃）不进异常清单', byRow(3)?.status === 'external' && !byRow(3)?.exceptionCategory, byRow(3));
  check('重复明细只保留一份', byRow(6)?.status === 'duplicate' && byRow(6)?.duplicateOfLineId === byRow(5)?.id, byRow(6));
  check('两朵 white flower 都保留；超过模板位置数 → 待核对，不丢图、不拆页', byRow(5)?.units.length === 1 && byRow(5)?.units[0]?.icons.length === 3 && byRow(5)?.status === 'review' && byRow(5)?.exceptionCategory === 'icon_layout', { u: byRow(5)?.units, s: byRow(5)?.status, c: byRow(5)?.exceptionCategory });
  check('套组展开为书包 + 餐包', byRow(7)?.units.map((u: any) => u.component).join(',') === '蓝色书包,蓝色餐包', byRow(7)?.units);
  check('BDK 不拆字母 → 待核对', byRow(8)?.status === 'review', byRow(8));

  const exc = (await api('GET', `/baskets/exceptions?recordId=${recordId}&limit=100`)).items;
  check('异常清单：未配置 ×2、待核对 ×1', exc.filter((l: any) => l.exceptionCategory === 'unmatched_sku').length === 2 && exc.some((l: any) => l.exceptionCategory === 'parse_review'), exc.map((l: any) => l.exceptionCategory));
  const noPages = (await api('GET', `/baskets/exceptions?recordId=${recordId}&orderNoPages=true`)).items;
  check('整单无页的订单在异常清单（订单 05）', noPages.some((l: any) => l.orderId === `9${S}05`), noPages.map((l: any) => l.orderId));
  const summary = await api('GET', `/baskets/exceptions/summary?recordId=${recordId}`);
  check('异常汇总', summary.ordersWithoutPages >= 1 && summary.categories.length >= 2, summary);
  const exportRes = await api('GET', `/baskets/exceptions/export?recordId=${recordId}`, undefined, { raw: true });
  const exportBuf = Buffer.from(await exportRes.arrayBuffer());
  const exportRows = XLSX.utils.sheet_to_json(XLSX.read(exportBuf).Sheets['异常清单']);
  check('导出异常清单 Excel', exportRows.length === exc.length, { rows: exportRows.length, exc: exc.length });
  const geo = await inspectZip(job.result.filePath);
  check('下载的 PPT 无越界 / 重叠', geo.length === 0, geo);

  // 5. SKU 复制（修正未配置）
  await api('POST', `/baskets/sku-config/${bagBlue.id}/copy`, { sku: bagBlue.sku }, { expect: 400 });
  check('复制 SKU：新 SKU 重名被拒绝', true);
  const copied = await api('POST', `/baskets/sku-config/${bagBlue.id}/copy`, { sku: `E2E-NEW-${stamp}` });
  check('复制 SKU：字段独立复制', copied.id !== bagBlue.id && copied.iconLayoutTemplateId === template.id && copied.copiedFromId === bagBlue.id && sortedJson(copied.nameLayout) === sortedJson(bagBlue.nameLayout), copied);
  await api('PUT', `/baskets/sku-config/${copied.id}`, { ...copied, replaceValue: '新品收纳包', user: undefined });
  const original = (await api('GET', `/baskets/sku-config?search=${encodeURIComponent(bagBlue.sku)}`)).items.find((c: any) => c.id === bagBlue.id);
  check('复制后修改副本，原配置不受影响', original?.replaceValue === '蓝色书包', original);

  // 6. 重新解析 → 补处理
  const unmatchedIds = exc.filter((l: any) => l.exceptionCategory === 'unmatched_sku').map((l: any) => l.id);
  const rep = await api('POST', '/baskets/lines/reprocess', { ids: unmatchedIds });
  check('重新解析：修正配置后变为"已修正，待生成"', rep.items.every((i: any) => i.status === 'ready'), rep);
  const regen = await api('POST', '/baskets/lines/regenerate', { ids: unmatchedIds });
  check('补处理生成新记录', !!regen.recordId && regen.stats.unitsProduced >= 3, regen);
  const newLines = (await api('GET', `/baskets/lines?recordId=${regen.recordId}&limit=100`)).items;
  const solo = newLines.find((l: any) => l.orderId === `9${S}05`);
  check('补处理：整单无页的订单已生成', solo?.status === 'produced' && solo?.orderHasPages === true, solo);
  const n1 = newLines.find((l: any) => l.sku === `E2E-NEW-${stamp}` && l.orderId === `9${S}01`);
  check('补处理：同订单全部明细一起重排，连单提醒更新', n1?.status === 'produced' && newLines.filter((l: any) => l.orderId === `9${S}01`).length === 3 && newLines.find((l: any) => l.sku === bagBlue.sku)?.reminderText === '连单：摇铃×2', newLines.map((l: any) => [l.sku, l.status, l.reminderText]));
  const excAfter = (await api('GET', `/baskets/exceptions?recordId=${recordId}`)).items;
  check('原记录的已补处理明细离开异常清单', !excAfter.some((l: any) => unmatchedIds.includes(l.id)), excAfter.map((l: any) => l.id));

  // 7. 人工指定（只作用于本行）
  const reviewLine = byRow(8);
  await api('PUT', `/baskets/lines/${reviewLine.id}/manual`, { override: { units: [{ itemIndex: 1, name: 'Hudson', icons: ['B'] }], note: '按顾客邮件确认' } });
  const fixed = await api('GET', `/baskets/lines/${reviewLine.id}`);
  check('人工指定后可生成', fixed.status === 'ready' && fixed.parseSource === 'manual', { status: fixed.status, src: fixed.parseSource, r: fixed.reviewReasons });
  await api('PUT', `/baskets/lines/${reviewLine.id}/manual`, { override: { units: [{ itemIndex: 1, name: 'Hudson', icons: ['BDK'] }] } });
  const bad = await api('GET', `/baskets/lines/${reviewLine.id}`);
  check('人工指定的图标也必须在图标组内', bad.status === 'review', bad.reviewReasons);
  await api('PUT', `/baskets/lines/${reviewLine.id}/manual`, { override: { units: [{ itemIndex: 1, name: 'Hudson', icons: ['B'] }] } });

  // 8. 整条记录重新生成（不重新上传）
  // 重新生成期间：不能删除记录，也不能对同一记录再发一次重新生成
  const regenPending = api('POST', `/baskets/records/${recordId}/regenerate`);
  await new Promise((r) => setTimeout(r, 150));
  const delDuring = await api('DELETE', `/baskets/records/${recordId}`, undefined, { raw: true, expect: 400 }).then((r: any) => r.json());
  const secondRegen = await api('POST', `/baskets/records/${recordId}/regenerate`, undefined, { raw: true, expect: 409 }).then((r: any) => r.json());
  const regenRecord = await regenPending;
  check('重新生成期间删除记录被拒绝、重复重新生成被拒绝，原任务正常完成', String(delDuring.message).includes('正在重新生成') && String(secondRegen.message).includes('正在重新生成') && !!regenRecord.outputFilePath, { delDuring, secondRegen });
  const rec = await api('GET', `/baskets/records/${recordId}`);
  check('整条记录按明细重新生成，旧文件留作备份', !!regenRecord.outputFilePath && rec.previousOutputs?.length === 1 && rec.outputFilePath === regenRecord.outputFilePath, { regenRecord, prev: rec.previousOutputs });
  const afterRegen = (await api('GET', `/baskets/lines?recordId=${recordId}&limit=100`)).items;
  check('重新生成后人工指定的行已制作', afterRegen.find((l: any) => l.id === undefined || l.rowIndex === 8)?.status === 'produced', afterRegen.find((l: any) => l.rowIndex === 8));

  // 9. 参考图
  const form = new FormData();
  form.append('file', icon('star'), 'ref.png');
  form.append('skuConfigId', String(bagBlue.id));
  const ref = await api('POST', '/baskets/reference-images', form, { form: true });
  const form2 = new FormData();
  form2.append('file', icon('lion'), 'ref2.png');
  form2.append('skuConfigId', String(bagBlue.id));
  form2.append('replaceId', String(ref.id));
  const replaced = await api('POST', '/baskets/reference-images', form2, { form: true });
  const refs = await api('GET', `/baskets/reference-images?skuConfigId=${bagBlue.id}`);
  check('参考图上传 / 更换', replaced.id === ref.id && replaced.fileName === 'ref2.png' && refs.own.length === 1 && refs.effective === 'sku', refs);
  await api('PUT', `/baskets/sku-config/${basketM.id}`, { ...basketM, referenceGroupKey: `母体-${stamp}`, user: undefined });
  const gform = new FormData();
  gform.append('file', icon('bow'), 'group.png');
  gform.append('groupKey', `母体-${stamp}`);
  await api('POST', '/baskets/reference-images', gform, { form: true });
  const grefs = await api('GET', `/baskets/reference-images?skuConfigId=${basketM.id}`);
  check('母体共用参考图', grefs.effective === 'group' && grefs.shared.length === 1, grefs);
  const job2 = await upload([{ 'Order ID': `9${S}09`, SKU: bagBlue.sku, Quantity: 1, Variations: 'Backpack ColorBlue\nPersonalizationWren, A' }], 'all', 'e2e-ref.xlsx');
  const geo2 = await inspectZip(job2.result.filePath, { slides: [{ containsText: ['参考图 · 非本单内容', 'Wren'] }] });
  const refLine = (await api('GET', `/baskets/lines?recordId=${job2.recordId}`)).items[0];
  check('参考图放在 PPT 左下角并标注非本单内容，不重叠、不影响名字和图标', geo2.length === 0 && refLine.units[0].name === 'Wren' && refLine.units[0].icons.map((i: any) => i.iconName).join() === 'A', refLine.units);
  const detail = await api('GET', `/baskets/lines/${refLine.id}`);
  check('审核页显示参考图', detail.referenceImages?.length === 1, detail.referenceImages);
  await api('DELETE', `/baskets/reference-images/${ref.id}`);
  check('参考图移除', (await api('GET', `/baskets/reference-images?skuConfigId=${bagBlue.id}`)).own.length === 0);

  // 9b. 批量设置（同一母体的多个子 SKU 一次改字体 / 图标上限 / 母体分组 / 名字区域）
  const batchKey = `E2E-批量-${stamp}`;
  const b1 = await api('POST', '/baskets/sku-config/batch-apply', { ids: [bagBlue.id, basketM.id, combo.id], patch: { font: 'Back to school', maxIcons: 4, referenceGroupKey: ` ${batchKey} ` } });
  const afterBatch = (await api('GET', `/baskets/sku-config?limit=50&search=${encodeURIComponent(stamp)}`)).items;
  const pick = (id: number) => afterBatch.find((c: any) => c.id === id);
  check('批量设置：勾选的字段应用到所有选中的 SKU（含套组），其他字段不变',
    b1.updated === 3 && !b1.failed.length && [bagBlue.id, basketM.id, combo.id].every((id) => pick(id)?.maxIcons === 4 && pick(id)?.referenceGroupKey === batchKey)
      && pick(bagBlue.id)?.replaceValue === '蓝色书包' && pick(basketM.id)?.nameLayout?.area?.y1 === 29, { b1, cfgs: afterBatch.map((c: any) => [c.sku, c.maxIcons, c.referenceGroupKey, c.replaceValue]) });
  const area = { area: { x1: 5, x2: 95, y1: 25, y2: 85 }, maxFontSize: 260, confirmed: true };
  const b2 = await api('POST', '/baskets/sku-config/batch-apply', { ids: [bagBlue.id, combo.id, 99999999], patch: { nameLayout: area } });
  const afterBatch2 = (await api('GET', `/baskets/sku-config?limit=50&search=${encodeURIComponent(stamp)}`)).items;
  check('批量设置：套组的名字区域跳过并说明原因，不存在 / 别人的 SKU 列为失败',
    b2.updated === 1 && b2.failed.length === 2 && b2.failed.some((f: any) => f.id === combo.id && f.reason.includes('组成件')) && b2.failed.some((f: any) => f.id === 99999999)
      && afterBatch2.find((c: any) => c.id === bagBlue.id)?.nameLayout?.area?.x1 === 5, b2);
  await api('POST', '/baskets/sku-config/batch-apply', { ids: [bagBlue.id], patch: { sku: 'X' } }, { expect: 400 });
  await api('POST', '/baskets/sku-config/batch-apply', { ids: [bagBlue.id], patch: { iconLayoutTemplateId: 99999999 } }).then((r: any) => {
    check('批量设置：SKU 编码等单个字段不能批量改；无效的布局模板被拒绝', r.updated === 0 && r.failed.length === 1, r);
  });
  await api('POST', '/baskets/sku-config/batch-apply', { ids: [bagBlue.id], patch: { nameLayout: bagBlue.nameLayout } });

  // 10. 店铺开关
  const settings = await api('PUT', '/baskets/shop-settings', { specialCharAnnotationFontSize: 36 });
  check('店铺开关保存', settings.specialCharAnnotationFontSize === 36);
  await api('PUT', '/baskets/shop-settings', { specialCharAnnotationFontSize: 40 });

  // 11. 按类型上传：只做套组，其余商品作为连单提醒
  const job3 = await upload([
    { 'Order ID': `9${S}10`, SKU: combo.sku, Quantity: 1, Variations: 'Set ColorBlue\nPersonalizationLeo' },
    { 'Order ID': `9${S}10`, SKU: bagBlue.sku, Quantity: 1, Variations: 'Backpack ColorBlue\nPersonalizationMax' },
  ], 'combo', 'e2e-combo.xlsx');
  const l3 = (await api('GET', `/baskets/lines?recordId=${job3.recordId}`)).items;
  check('orderType=combo：书包本次不做，作为连单提醒，不进异常', l3.find((l: any) => l.sku === bagBlue.sku)?.status === 'out_of_scope' && l3.find((l: any) => l.sku === combo.sku)?.reminderText === '连单：蓝色书包×1', l3.map((l: any) => [l.sku, l.status, l.reminderText]));

  // 12. 图标布局模板仍被使用时不能停用
  await api('DELETE', `/baskets/layout-templates/${template.id}`, undefined, { expect: 400 });
  check('使用中的布局模板不能停用', true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
