import { read, utils } from 'xlsx';
import * as dayjs from 'dayjs';
import { IconIndex } from './icon-index';
import { matchSkuConfig } from './sku-matcher';
import { decodeEntities, dedupeReasons, parseVariations } from './variation-parser';
import { LLM_RETRY_CODES, LlmCall, tryLlmFallback } from './llm-fallback';
import { assignIconSlots, SYSTEM_DEFAULT_TEMPLATE } from './layout';
import {
  ColorEntry,
  ComboOverride,
  DEFAULT_SHOP_SETTINGS,
  FontEntry,
  IconEntry,
  LayoutTemplateLike,
  LineDraft,
  ManualOverride,
  NameLayoutConfig,
  ParsedIcon,
  ParsedItem,
  ParseResult,
  ProductionUnit,
  RawRow,
  Reason,
  ShopSettings,
  SkuConfigLike,
} from './types';

export const PIPELINE_VERSION = 'basket-v2.0';

export interface PipelineContext {
  configs: SkuConfigLike[];
  iconGroups: Map<number, IconEntry[]>;
  colorGroups: Map<number, ColorEntry[]>;
  layoutTemplates: Map<number, LayoutTemplateLike>;
  fonts: FontEntry[];
  settings: ShopSettings;
  /** 上传时选择的订单类型：all 或某个 SKU 类型 */
  orderTypeScope: string;
  llm?: LlmCall | null;
}

const blocking = (code: string, message: string, system = false): Reason => ({ code, message, severity: 'blocking', system });
const warning = (code: string, message: string): Reason => ({ code, message, severity: 'warning' });

// ---------------------------------------------------------------- Excel

export function readExcelRows(buffer: Buffer): RawRow[] {
  const workbook = read(buffer, { type: 'buffer' });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = utils.sheet_to_json<Record<string, any>>(worksheet, { defval: '' });
  return rows.map((row, i) => {
    const cells: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      const k = String(key).replace(/\s+/g, ' ').trim();
      if (!k || /^__EMPTY/.test(k)) continue;
      if (cells[k] !== undefined && cells[k] !== '') continue;
      cells[k] = value === null || value === undefined ? '' : String(value);
    }
    // 第一行是表头，Excel 行号 = 下标 + 2
    return { rowIndex: i + 2, cells };
  });
}

function pick(cells: Record<string, string>, names: string[]): string {
  for (const name of names) {
    const v = cells[name];
    if (v !== undefined && v !== null && String(v) !== '') return String(v);
  }
  return '';
}

export const NOTE_COLUMNS = ['Note', 'NOTE', 'Notes', 'Buyer Note', 'Buyer Notes', 'Order Note', 'Note from Buyer', 'Message from Buyer', 'Message From Buyer', 'Order Private Notes', '备注', '买家备注', '买家留言'];

export function formatExcelDate(value: string): string {
  if (!value) return '';
  const num = Number(value);
  if (!isNaN(num) && num > 0 && num < 100000) {
    let serial = Math.floor(num);
    if (serial > 59) serial -= 1;
    return dayjs('1899-12-31').add(serial, 'day').format('YYYY年MM月DD日');
  }
  const parsed = dayjs(value);
  if (parsed.isValid()) return parsed.format('YYYY年MM月DD日');
  return String(value);
}

export function buildLineDrafts(rows: RawRow[]): LineDraft[] {
  const lines: LineDraft[] = [];
  const firstByKey = new Map<string, LineDraft>();
  for (const row of rows) {
    const c = row.cells;
    const orderId = pick(c, ['Order ID', 'OrderID', '订单ID', '订单号']).trim();
    const sku = pick(c, ['SKU', 'sku']);
    const quantityRaw = pick(c, ['Quantity', '数量']);
    const variationsRaw = pick(c, ['Variations', '变量']);
    const noteCols = NOTE_COLUMNS.filter((n) => c[n] !== undefined && String(c[n]) !== '');
    const notes = noteCols.map((n) => (noteCols.length > 1 ? `[${n}] ` : '') + c[n]);
    const noteRaw = notes.length ? notes.join('\n') : null;
    if (!orderId && !sku && !variationsRaw) continue; // 空行
    const qNum = Number(String(quantityRaw).trim() || '1');
    const quantity = Number.isInteger(qNum) && qNum >= 1 ? qNum : 1;
    const dedupeKey = [orderId, sku, quantityRaw, variationsRaw, noteRaw ?? ''].join('\u0001');
    const addressParts = [
      pick(c, ['Ship Address1', 'Ship Address 1', '地址1']),
      pick(c, ['Ship Address2', 'Ship Address 2', '地址2']),
      pick(c, ['Ship City', '城市']),
      pick(c, ['Ship State', '省/州']),
      pick(c, ['Ship Zipcode', 'Ship Zip', '邮编']),
      pick(c, ['Ship Country', '国家']),
    ].filter(Boolean);
    const draft: LineDraft = {
      rowIndex: row.rowIndex,
      orderId,
      transactionId: pick(c, ['Transaction ID']) || null,
      sku,
      itemName: pick(c, ['Item Name', '商品名称']) || null,
      quantity,
      quantityRaw: String(quantityRaw),
      variationsRaw,
      noteRaw,
      shipName: pick(c, ['Ship Name', '收件人姓名', '收件人']) || null,
      orderDate: pick(c, ['Sale Date', 'Order Date', '下单日期', '下单时间']) || null,
      datePaid: pick(c, ['Date Paid', '付款日期']) || null,
      shipState: pick(c, ['Ship State', '省/州']) || null,
      shipAddress: addressParts.join(', ') || null,
      rawRow: c,
      dedupeKey,
      duplicateOfRowIndex: null,
      matchStatus: 'none',
      skuConfigId: null,
      matchedSku: null,
      matchNote: null,
      produceMode: null,
      parse: null,
      units: [],
      status: 'pending',
      exceptionCategory: null,
      reasons: [],
      warnings: [],
      expectedUnits: 0,
      producedUnits: 0,
      producedSlides: [],
      reminderText: null,
      orderHasPages: false,
    };
    if (!(Number.isInteger(qNum) && qNum >= 1)) {
      draft.reasons.push(blocking('quantity_invalid', `Quantity "${quantityRaw}" 不是有效件数，请核对`));
    }
    if (!orderId) draft.warnings.push(warning('order_id_missing', '订单号为空，无法做同订单去重和连单核对'));
    // 完全相同的重复明细（同订单、同 SKU、同 Quantity、同完整选项和定制要求）视为导出重复，只保留一份
    if (orderId) {
      const first = firstByKey.get(dedupeKey);
      if (first) {
        draft.duplicateOfRowIndex = first.rowIndex;
        draft.status = 'duplicate';
      } else {
        firstByKey.set(dedupeKey, draft);
      }
    }
    lines.push(draft);
  }
  return lines;
}

// ---------------------------------------------------------------- 颜色

function normColorKey(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/[\s_\-]+/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}

export function mapColor(raw: string | null, entries: ColorEntry[] | null, legacyMap: Record<string, string> | null): { mapped: string | null; warning: Reason | null } {
  if (!raw) return { mapped: null, warning: null };
  const list: ColorEntry[] = entries && entries.length ? entries : Object.entries(legacyMap || {}).map(([name, colorValue]) => ({ name, colorValue }));
  if (!list.length) return { mapped: null, warning: warning('color_no_group', `SKU 没有关联颜色组，颜色保留原值 "${raw}"`) };
  const key = normColorKey(raw);
  const hits = list.filter((e) => normColorKey(e.name) === key);
  const values = Array.from(new Set(hits.map((h) => h.colorValue.trim())));
  if (!values.length) return { mapped: null, warning: warning('color_unmapped', `颜色 "${raw}" 在颜色组中没有对应，保留原值，请核对`) };
  if (values.length > 1) return { mapped: null, warning: warning('color_conflict', `颜色 "${raw}" 在颜色组中有多个译法（${values.join(' / ')}），保留原值，请核对`) };
  if (/^(混|彩)\s*\d+$/.test(values[0])) {
    return { mapped: values[0], warning: warning('color_shorthand', `颜色 "${raw}" 只维护了简写 "${values[0]}"，没有完整中文配方，请在颜色组补充`) };
  }
  return { mapped: values[0], warning: null };
}

// ---------------------------------------------------------------- 套组组成件

const COMPONENT_KEYWORDS: Array<[RegExp, RegExp]> = [
  [/餐包|lunch/i, /lunch|snack/i],
  [/笔袋|pencil|pouch/i, /pencil|pouch/i],
  [/书包|backpack|^[\p{L}]+\d$/iu, /back ?pack|book ?bag|school ?bag/i],
];

function mapSectionToComponent(header: string, components: string[]): string | null {
  for (const [componentRe, headerRe] of COMPONENT_KEYWORDS) {
    if (headerRe.test(header)) {
      const hits = components.filter((c) => componentRe.test(c));
      if (hits.length === 1) return hits[0];
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 单行分析

export interface AnalyzeOptions {
  ctx: PipelineContext;
}

function iconIndexFor(groupId: number | null | undefined, ctx: PipelineContext, cache: Map<number, IconIndex>): IconIndex {
  const id = groupId ? Number(groupId) : 0;
  if (!cache.has(id)) cache.set(id, new IconIndex(id ? ctx.iconGroups.get(id) || [] : []));
  return cache.get(id)!;
}

function overrideFor(cfg: SkuConfigLike, component: string | null): ComboOverride {
  if (!component) return {};
  return (cfg.comboOverridesJson || {})[component] || {};
}

function latinLetterCount(name: string): number {
  return (name.match(/\p{Script=Latin}/gu) || []).length;
}

export function categorize(reasons: Reason[]): string | null {
  const b = reasons.find((r) => r.severity === 'blocking');
  if (!b) return null;
  const map: Record<string, string> = {
    sku_unmatched: 'unmatched_sku',
    sku_conflict: 'sku_conflict',
    icon_asset_missing: 'icon_asset_missing',
    icon_unreadable: 'icon_asset_missing',
    icon_insert_failed: 'icon_insert_failed',
    font_missing: 'font_error',
    glyph_missing: 'font_error',
    font_measure_failed: 'font_error',
    name_not_fit: 'name_layout',
    name_too_long_letters: 'name_layout',
    area_invalid: 'name_layout',
    layout_over_capacity: 'icon_layout',
    layout_no_rule: 'icon_layout',
    layout_complex: 'icon_layout',
    layout_slot_missing: 'icon_layout',
    position_conflict: 'icon_layout',
    position_not_in_template: 'icon_layout',
    position_name_after: 'icon_layout',
    icon_over_limit: 'icon_limit',
    icon_group_missing: 'icon_config',
    generation_failed: 'generation_failed',
  };
  return map[b.code] || 'parse_review';
}

export async function analyzeLine(line: LineDraft, ctx: PipelineContext, indexCache = new Map<number, IconIndex>()): Promise<LineDraft> {
  line.units = [];
  line.expectedUnits = 0;
  line.producedUnits = 0;
  line.producedSlides = [];
  line.reasons = line.reasons.filter((r) => r.code === 'quantity_invalid');
  line.warnings = line.warnings.filter((r) => r.code === 'order_id_missing');
  line.exceptionCategory = null;
  if (line.status === 'duplicate') return line;

  // 1. SKU 匹配（全部配置里匹配，再看类型是否在本次范围内）
  const match = matchSkuConfig(line.sku, ctx.configs);
  line.matchStatus = match.status;
  line.skuConfigId = match.config?.id ?? null;
  line.matchedSku = match.config?.sku ?? null;
  line.matchNote = match.note;
  if (match.status === 'unmatched') {
    line.status = 'unmatched';
    line.reasons.push(blocking('sku_unmatched', match.note || 'SKU 未配置', true));
    line.exceptionCategory = 'unmatched_sku';
    return line;
  }
  if (match.status === 'conflict') {
    line.status = 'conflict';
    line.reasons.push(blocking('sku_conflict', match.note || 'SKU 匹配冲突', true));
    line.exceptionCategory = 'sku_conflict';
    return line;
  }
  const cfg = match.config!;
  if (match.status === 'prefix') line.warnings.push(warning('sku_prefix_match', match.note!));
  const produceMode = (cfg.produceMode || 'ppt') as LineDraft['produceMode'];
  line.produceMode = cfg.type === 'sweater' && produceMode === 'ppt' ? 'external' : produceMode;
  if (line.produceMode === 'ignore') {
    line.status = 'ignored';
    return line;
  }
  if (line.produceMode === 'external') {
    line.status = 'external';
    return line;
  }
  if (ctx.orderTypeScope !== 'all' && cfg.type !== ctx.orderTypeScope) {
    line.status = 'out_of_scope';
    line.warnings.push(warning('out_of_scope', `SKU 类型 ${cfg.type} 不在本次上传选择的类型 ${ctx.orderTypeScope} 内，本次不生成`));
    return line;
  }

  // 2. 解析 Variations
  const isCombo = cfg.type === 'combo' && Array.isArray(cfg.comboItems) && cfg.comboItems.length > 0;
  const baseGroupId = cfg.iconGroupId ?? (isCombo ? Object.values(cfg.comboOverridesJson || {}).find((o) => o?.iconGroupId)?.iconGroupId : null) ?? null;
  const baseIndex = iconIndexFor(baseGroupId, ctx, indexCache);

  let parse: ParseResult;
  if (line.manualOverride) {
    parse = manualParse(line.manualOverride, line.variationsRaw, baseIndex);
  } else {
    parse = parseVariations(line.variationsRaw, baseIndex);
    const retry = parse.reasons.some((r) => r.severity === 'blocking' && LLM_RETRY_CODES.has(r.code));
    if (retry) {
      const llm = await tryLlmFallback(ctx.llm || null, line.variationsRaw, baseIndex, parse.fields);
      if (llm.reason) parse.reasons.push(llm.reason);
      if (llm.used && llm.validation) {
        if (llm.validation.ok) {
          // 默认 LLM 结果只作为建议：带入明细（人工修正表单会预填），但要人工确认后才制作。
          // 真实数据里通过校验的 LLM 结果仍出现过错名；BASKET_LLM_AUTO_ACCEPT=true 时恢复为直接采用
          const autoAccept = process.env.BASKET_LLM_AUTO_ACCEPT === 'true';
          const suggestion = llm.validation.items
            .map((item) => `${item.name ?? '（无名字）'}${item.icons.length ? ` + ${item.icons.map((i) => i.iconName || i.raw).join('、')}` : ''}`)
            .join('；');
          parse = {
            ...parse,
            items: llm.validation.items,
            source: 'llm',
            reasons: [
              ...parse.reasons.filter((r) => !LLM_RETRY_CODES.has(r.code) && r.severity !== 'blocking'),
              autoAccept
                ? warning('parsed_by_llm', '规则无法拆分，采用了通过校验的 LLM 结果，请抽查')
                : blocking('llm_needs_confirm', `规则无法拆分，LLM 建议：${suggestion}。请核对原文，在"人工指定"里确认或修改后再制作`),
            ],
          };
        } else {
          parse.reasons.push(blocking('llm_rejected', `LLM 结果未通过校验：${llm.validation.errors.join('；')}`));
        }
      }
    }
  }
  line.parse = parse;
  for (const r of parse.reasons) (r.severity === 'blocking' ? line.reasons : line.warnings).push(r);

  // 3. 展开制作单元
  const q = line.quantity;
  const components: Array<string | null> = isCombo ? (cfg.comboItems as string[]) : [null];
  const items = parse.items;
  const unitItems: Array<{ itemIndex: number; component: string | null; item: ParsedItem | null }> = [];
  const mappingReasons: Reason[] = [];

  if (!isCombo) {
    let mapped: Array<ParsedItem | null> = [];
    if (items.length === q) mapped = items;
    else {
      mapped = Array.from({ length: q }, () => null);
      if (items.length === 1 && q > 1) {
        mappingReasons.push(blocking('qty_name_mismatch', `Quantity=${q}，但只有 1 个名字 "${items[0].name ?? ''}"：不确定每件是否同名，不自动复制，请核对`));
      } else if (items.length > 0) {
        const extra = q === 1 ? items.slice(1).filter((i) => i.name && !i.icons.length && !/\s/.test(i.name)) : [];
        mappingReasons.push(blocking('qty_name_mismatch', extra.length === items.length - 1 && extra.length
          ? `Quantity=1，"${items[0].name}" 后面的 ${extra.map((i) => `"${i.name}"`).join('、')} 不在该 SKU 的图标组里，也不能确定是名字，请核对（可在图标组补充别名）`
          : `Quantity=${q}，识别出 ${items.length} 组名字 / 图标（${items.map((i) => i.name ?? '(无名字)').join('、')}），无法逐件对应，请核对`));
      }
    }
    for (let i = 0; i < q; i++) unitItems.push({ itemIndex: i + 1, component: null, item: mapped[i] });
  } else {
    const sectioned = items.filter((it) => it.component);
    const perComponent = new Map<string, ParsedItem>();
    let shared: ParsedItem | null = null;
    if (sectioned.length) {
      for (const it of sectioned) {
        const comp = mapSectionToComponent(it.component!, components as string[]);
        if (!comp || perComponent.has(comp)) {
          mappingReasons.push(blocking('combo_mapping', `套组内的 "${it.component}" 无法唯一对应到组成件（${components.join('、')}），请核对`));
          continue;
        }
        perComponent.set(comp, { ...it, component: comp });
      }
      const general = items.filter((it) => !it.component);
      if (general.length === 1) shared = general[0];
      else if (general.length > 1) mappingReasons.push(blocking('combo_mapping', '套组里有多组未指定组成件的名字，无法对应，请核对'));
      if (q > 1) mappingReasons.push(blocking('combo_mapping', `套组 Quantity=${q} 且有按组成件指定的要求，无法确定对应哪一套，请核对`));
    } else if (items.length === 1 && q === 1) {
      shared = items[0];
    } else if (items.length > 0) {
      mappingReasons.push(blocking('combo_mapping', `套组 Quantity=${q}，识别出 ${items.length} 组名字（${items.map((i) => i.name ?? '(无名字)').join('、')}），名字与组成件不能可靠对应，请核对`));
    }
    for (let i = 0; i < q; i++) {
      for (const comp of components) {
        const own = perComponent.get(comp!);
        // 公共要求应用于所有组成件；明确指定某件时以该件为准
        unitItems.push({ itemIndex: i + 1, component: comp, item: own || shared });
      }
    }
  }
  line.reasons.push(...mappingReasons);
  line.expectedUnits = unitItems.length;

  for (const ui of unitItems) {
    const override = overrideFor(cfg, ui.component);
    const reasons: Reason[] = [];
    const groupId = (override.iconGroupId ?? cfg.iconGroupId ?? null) as number | null;
    const index = iconIndexFor(groupId, ctx, indexCache);
    // 组成件使用不同的图标组时，按完整编号重新在该组内查找
    const icons: ParsedIcon[] = [];
    for (const icon of ui.item?.icons || []) {
      if ((groupId || 0) === (baseGroupId || 0)) {
        icons.push({ ...icon });
        continue;
      }
      const found = index.lookup(icon.iconName || icon.raw);
      if (found.status !== 'ok') {
        reasons.push(blocking('icon_not_found', `图标 "${icon.raw}" 不在组成件 ${ui.component} 的图标组内`));
        continue;
      }
      icons.push({ ...icon, iconId: found.entry!.id, iconName: found.entry!.code || found.entry!.name, kind: found.entry!.kind || 'large', filePath: found.entry!.filePath, fileExists: found.entry!.fileExists });
    }
    // 三段校验的第二段：素材存在
    for (const icon of icons) {
      if (!icon.fileExists) {
        reasons.push(blocking('icon_asset_missing', `图标 ${icon.iconName} 已识别，但素材文件不存在（${icon.filePath}）`, true));
      }
    }
    const maxIcons = override.maxIcons ?? cfg.maxIcons ?? null;
    if (maxIcons !== null && maxIcons !== undefined && icons.length > maxIcons) {
      reasons.push(blocking('icon_over_limit', `图标 ${icons.length} 个，超过该 SKU${ui.component ? `（${ui.component}）` : ''} 的上限 ${maxIcons} 个，不丢图、不拆页，请核对`));
    }
    const name = ui.item?.name ?? null;
    if (!name && !mappingReasons.length && !line.reasons.some((r) => r.code === 'no_name')) {
      reasons.push(blocking('no_name', '这一件没有名字，请核对'));
    }
    const nameLayout: NameLayoutConfig | null = override.nameLayout || cfg.nameLayout || null;
    if (name && nameLayout?.maxLatinLetters && latinLetterCount(name) > nameLayout.maxLatinLetters) {
      reasons.push(blocking('name_too_long_letters', `名字 "${name}" 有 ${latinLetterCount(name)} 个拉丁字母，超过该 SKU 的 ${nameLayout.maxLatinLetters} 个，请核对`));
    }
    // 图标布局
    const templateId = (override.iconLayoutTemplateId ?? cfg.iconLayoutTemplateId ?? null) as number | null;
    let template = templateId ? ctx.layoutTemplates.get(Number(templateId)) || null : null;
    const unitWarnings: Reason[] = [];
    if (icons.length) {
      if (templateId && !template) {
        reasons.push(blocking('layout_slot_missing', `SKU 选择的图标布局模板 #${templateId} 不存在或已停用`, true));
      }
      if (!template && !templateId) {
        if (ctx.settings.allowDefaultIconLayout) {
          template = SYSTEM_DEFAULT_TEMPLATE;
          unitWarnings.push(warning('default_icon_layout', 'SKU 未选择图标布局模板，按系统默认位置排列'));
        } else {
          reasons.push(blocking('layout_no_template', 'SKU 未选择图标布局模板'));
        }
      }
      if (template) {
        const layout = assignIconSlots(icons, template);
        reasons.push(...layout.reasons);
        (ui as any).slots = layout.assignments;
      }
    }
    // 颜色
    const colorGroupId = (override.colorGroupId ?? cfg.colorGroupId ?? null) as number | null;
    const color = mapColor(parse.colorRaw, colorGroupId ? ctx.colorGroups.get(Number(colorGroupId)) || [] : null, colorGroupId ? null : cfg.yarnColorMap || null);
    if (color.warning) unitWarnings.push(color.warning);
    if (!nameLayout?.area) {
      unitWarnings.push(warning('area_unconfirmed', '该 SKU 的名字安全区域未配置（区域未确认），按默认区域测量'));
    } else if (!nameLayout.confirmed) {
      unitWarnings.push(warning('area_preset_unverified', `名字区域来自${nameLayout.presetKey ? '附表预设 ' + nameLayout.presetKey : '手工配置'}，SKU 与预设的对应尚未标记为已确认`));
    }

    const unit: ProductionUnit = {
      unitKey: `${line.rowIndex}-${ui.itemIndex}${ui.component ? '-' + ui.component : ''}`,
      itemIndex: ui.itemIndex,
      component: ui.component,
      name,
      // 布局没有排成功时保留全部图标（不丢图），这一件进入待核对
      icons: (ui as any).slots && (ui as any).slots.length === icons.length
        ? ((ui as any).slots as any[]).map((a) => ({ ...a.icon, position: a.icon.position, slot: a.slot }))
        : icons,
      colorRaw: parse.colorRaw,
      colorMapped: color.mapped,
      iconGroupId: groupId,
      layoutTemplateId: template ? template.id : null,
      nameLayout,
      fontSize: (override.fontSize ?? cfg.fontSize ?? null) as number | null,
      font: cfg.font || null,
      status: reasons.some((r) => r.severity === 'blocking') ? 'review' : 'ok',
      reasons: [...reasons, ...unitWarnings],
    };
    line.units.push(unit);
  }

  for (const u of line.units) {
    for (const r of u.reasons) {
      const target = r.severity === 'blocking' ? line.reasons : line.warnings;
      if (!target.some((x) => x.code === r.code && x.message === r.message)) target.push(r);
    }
  }
  line.reasons = dedupeReasons(line.reasons);
  line.warnings = dedupeReasons(line.warnings);
  if (line.reasons.some((r) => r.severity === 'blocking')) {
    line.status = line.reasons.some((r) => r.system) ? 'failed' : 'review';
    line.exceptionCategory = categorize(line.reasons);
  } else {
    line.status = 'pending';
  }
  return line;
}

function manualParse(override: ManualOverride, variationsRaw: string, index: IconIndex): ParseResult {
  const reasons: Reason[] = [];
  const items: ParsedItem[] = override.units.map((u) => {
    const icons: ParsedIcon[] = [];
    (u.icons || []).forEach((raw, i) => {
      const found = index.lookup(raw);
      if (found.status !== 'ok') {
        reasons.push(blocking('icon_not_found', `人工指定的图标 "${raw}" 不在 SKU 图标组内`));
        return;
      }
      icons.push({
        raw,
        iconId: found.entry!.id,
        iconName: found.entry!.code || found.entry!.name,
        kind: found.entry!.kind || 'large',
        filePath: found.entry!.filePath,
        fileExists: found.entry!.fileExists,
        position: u.positions?.[i] || null,
        positionRaw: u.positions?.[i] || null,
      });
    });
    return { name: u.name, icons, component: u.component || null };
  });
  const base = parseVariations(variationsRaw, index);
  return {
    ...base,
    items,
    reasons: [...reasons, { code: 'manual_override', message: `人工指定了名字 / 图标${override.note ? '：' + override.note : ''}`, severity: 'warning' }],
    source: 'manual',
  };
}

// ---------------------------------------------------------------- 连单核对、页码、异常

export function lineDisplayName(line: LineDraft, cfg: SkuConfigLike | undefined): string {
  return (cfg?.replaceValue && cfg.replaceValue.trim()) || (line.itemName && line.itemName.trim().slice(0, 40)) || line.sku || '未知商品';
}

export interface OrderSummary {
  orderId: string;
  producedUnits: number;
  reminderText: string | null;
  hasPages: boolean;
}

/**
 * 从 Excel 读取同订单全部商品，与实际成功生成的制作单元核对：
 * - 没有生成的商品（正常连单、本次范围外、生成失败、解析待核对、未配置）都写进该订单每一页的连单提醒
 * - 失败的另外进入异常清单；整单没有任何制作页时，异常清单里保留 order_no_pages
 */
export function reconcileOrders(lines: LineDraft[], configs: SkuConfigLike[]): Map<string, OrderSummary> {
  const cfgById = new Map(configs.map((c) => [c.id, c]));
  const byOrder = new Map<string, LineDraft[]>();
  for (const line of lines) {
    const key = line.orderId || `__row${line.rowIndex}`;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key)!.push(line);
  }
  const result = new Map<string, OrderSummary>();
  for (const [orderKey, orderLines] of byOrder) {
    const produced = orderLines.reduce((n, l) => n + (l.status === 'produced' ? l.producedUnits : 0), 0);
    const notGenerated = orderLines.filter((l) => !['produced', 'duplicate', 'ignored'].includes(l.status));
    const parts: string[] = [];
    const grouped = new Map<string, number>();
    for (const l of notGenerated) {
      const failed = ['review', 'failed', 'unmatched', 'conflict', 'pending'].includes(l.status);
      const label = `${lineDisplayName(l, l.skuConfigId ? cfgById.get(l.skuConfigId) : undefined)}${failed ? '（未生成，待处理）' : ''}`;
      grouped.set(label, (grouped.get(label) || 0) + l.quantity);
    }
    for (const [label, qty] of grouped) parts.push(`${label}×${qty}`);
    const reminderText = parts.length ? `连单：${parts.join('、')}` : null;
    const hasPages = produced > 0;
    const expectsPages = orderLines.some((l) => ['review', 'failed', 'unmatched', 'conflict', 'produced', 'pending'].includes(l.status));
    for (const l of orderLines) {
      l.reminderText = reminderText;
      l.orderHasPages = hasPages;
      if (!hasPages && expectsPages && l.status !== 'duplicate' && !l.warnings.some((r) => r.code === 'order_no_pages')) {
        if (['review', 'failed', 'unmatched', 'conflict'].includes(l.status)) {
          l.warnings.push(warning('order_no_pages', '整单没有任何制作页'));
        }
      }
    }
    result.set(orderKey, { orderId: orderKey, producedUnits: produced, reminderText, hasPages });
  }
  return result;
}
