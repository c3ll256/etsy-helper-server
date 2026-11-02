import { IconIndex } from './icon-index';
import { analyzeLine, categorize, formatExcelDate, lineDisplayName, PipelineContext, reconcileOrders } from './line-pipeline';
import { decodeEntities } from './variation-parser';
import { replaceSkuDisplayValue } from '../sku-display.util';
import { LineDraft, ProductionUnit, Reason, SkuConfigLike } from './types';

/**
 * 母婴生成流水线（与数据库无关，回归脚本和 basket.service 共用）：
 * 1. 逐行分析：SKU 匹配 → 规则解析（必要时校验后的 LLM）→ 展开制作单元 → 图标 / 颜色 / 布局校验
 * 2. 布局计划：交给 Python 用真实字体测量名字，放不下 / 缺字体 / 缺字的行转为待核对或系统异常
 * 3. 连单核对 + 组内页码（只数实际制作单元）+ 全局编号
 * 4. 渲染 PPT，并按实际插入的图标数做第三段校验
 */

export type PythonRunner = (request: any) => Promise<any>;

export interface RunMeta {
  shopName: string;
  processDate: string;
}

export interface PipelineOutput {
  pptBase64: string | null;
  lines: LineDraft[];
  slides: any[];
  reports: any[];
  stats: {
    linesTotal: number;
    unitsProduced: number;
    slidesTotal: number;
    placeholders: number;
    exceptionLines: number;
    warningLines: number;
  };
}

const WARNING_ON_PAGE: Record<string, (r: Reason, unit: ProductionUnit) => string> = {
  color_unmapped: (_r, u) => `颜色待核对：原值 ${u.colorRaw}`,
  color_conflict: (_r, u) => `颜色待核对（映射冲突）：原值 ${u.colorRaw}`,
  color_no_group: (_r, u) => `颜色未映射：原值 ${u.colorRaw}`,
  color_shorthand: (_r, u) => `颜色只有简写，缺完整配方：${u.colorRaw}`,
  area_unconfirmed: () => '名字区域未确认',
  default_icon_layout: () => '图标位置：系统默认（SKU 未选布局模板）',
  parsed_by_llm: () => 'LLM 解析结果，请抽查',
  manual_override: () => '人工指定名字 / 图标',
};

function settleUnitWarnings(unit: ProductionUnit): string[] {
  const out: string[] = [];
  for (const r of unit.reasons) {
    if (r.severity !== 'warning') continue;
    const fn = WARNING_ON_PAGE[r.code];
    if (fn) {
      const text = fn(r, unit);
      if (!out.includes(text)) out.push(text);
    }
  }
  return out;
}

function oneLine(text: string): string {
  return decodeEntities(text || '').replace(/\r?\n+/g, ' / ').trim();
}

/** Tools02 页眉格子：收件人、数量、订单号 */
function headerOf(line: LineDraft) {
  return { recipient: line.shipName || '', quantity: line.quantity, orderNumber: line.orderId || '' };
}

function buildSlides(lines: LineDraft[], ctx: PipelineContext, meta: RunMeta) {
  const cfgById = new Map<number, SkuConfigLike>(ctx.configs.map((c) => [c.id, c]));
  const summaries = reconcileOrders(lines, ctx.configs);
  const counters = new Map<string, number>();
  const slides: any[] = [];
  const fonts = ctx.fonts.filter((f) => f.fileExists).map((f) => ({ name: f.name, path: f.filePath }));

  for (const line of lines) {
    const cfg = line.skuConfigId ? cfgById.get(line.skuConfigId) : undefined;
    const orderKey = line.orderId || `__row${line.rowIndex}`;
    const summary = summaries.get(orderKey);
    const orderDate = formatExcelDate(line.datePaid || line.orderDate || '');
    const common = {
      orderId: line.orderId,
      orderDate,
      processDate: `处理 ${meta.processDate}`,
      shopName: meta.shopName,
      reminder: summary?.reminderText || null,
      staticReminder: cfg?.externalOrderReminderEnabled && cfg.externalOrderReminderContent ? cfg.externalOrderReminderContent : null,
      qr: line.orderId,
      rowIndex: line.rowIndex,
    };
    if (line.status === 'produced') {
      const total = summary?.producedUnits || line.units.length;
      for (const unit of line.units) {
        const k = (counters.get(orderKey) || 0) + 1;
        counters.set(orderKey, k);
        unit.groupPosition = `${k}/${total}`;
        const display = unit.component || replaceSkuDisplayValue(line.sku, cfg?.sku, cfg?.replaceValue);
        const colorText = unit.colorMapped || unit.colorRaw || '';
        const iconText = unit.icons.map((i) => i.iconName).join(',');
        const title = [line.orderId, display, colorText, iconText].filter((p) => p && String(p).trim()).join(' - ');
        // 收件人、数量、订单号、图标、产品名、颜色在页眉格子里；详情区放原始定制和本页制作内容
        const details = [
          `原始定制：${oneLine(line.variationsRaw)}`,
          `制作：SKU ${line.sku}${unit.component ? ' · 组成件 ' + unit.component : ''} · 第 ${unit.itemIndex}/${line.quantity} 件 | 名字 ${unit.name ?? '-'} | 图标 ${iconText || '无'} (${unit.icons.length}) | 颜色 ${unit.colorRaw || '-'}${unit.colorMapped ? ' → ' + unit.colorMapped : ''}`,
          ...(line.parse?.attachments || []).map((a) => `附件：${a}（附件说明，不计件数）`),
        ];
        slides.push({
          ...common,
          kind: 'production',
          key: unit.unitKey,
          title,
          header: { ...headerOf(line), icon: iconText, product: display, color: colorText },
          groupPosition: unit.groupPosition,
          quantityText: line.quantity > 1 ? `数量 ${line.quantity}` : '',
          details,
          warnings: settleUnitWarnings(unit),
          name: {
            text: unit.name,
            font: unit.font,
            legacyFontSize: unit.fontSize,
            layout: unit.nameLayout || {},
            special: {
              mode: ctx.settings.specialCharFontMode,
              font: ctx.settings.specialCharFont,
              ampersandSizeDelta: ctx.settings.ampersandSizeDelta,
              annotation: {
                enabled: ctx.settings.specialCharAnnotationEnabled,
                font: ctx.settings.specialCharAnnotationFont,
                fontSize: ctx.settings.specialCharAnnotationFontSize,
              },
            },
          },
          icons: unit.icons.map((icon: any) => ({ iconName: icon.iconName, path: icon.filePath, slot: icon.slot })),
        });
      }
    } else if ((line.status === 'review' || line.status === 'failed') && line.produceMode === 'ppt' && ctx.settings.reviewPlaceholderPages) {
      slides.push({
        ...common,
        kind: 'placeholder',
        key: `${line.rowIndex}-placeholder`,
        title: [line.orderId, lineDisplayName(line, cfg), '待核对'].filter(Boolean).join(' - '),
        header: { ...headerOf(line), icon: '', product: lineDisplayName(line, cfg), color: '' },
        groupPosition: '待核对',
        quantityText: line.quantity > 1 ? `数量 ${line.quantity}` : '',
        details: [`SKU ${line.sku} · Quantity ${line.quantityRaw}`, `原始定制：${oneLine(line.variationsRaw)}`],
        warnings: [],
        placeholder: {
          title: line.status === 'failed' ? '系统异常：本行未生成，不可制作' : '待核对：本行未生成，不可制作',
          reasons: line.reasons.filter((r) => r.severity === 'blocking').map((r) => r.message),
        },
        icons: [],
      });
    }
  }
  slides.forEach((s, i) => (s.globalNumber = `全局 ${i + 1}/${slides.length}`));
  return { slides, fonts };
}

function markFromPlanErrors(line: LineDraft, errors: Array<{ code: string; message: string; system?: boolean }>) {
  for (const e of errors) {
    if (!line.reasons.some((r) => r.code === e.code && r.message === e.message)) {
      line.reasons.push({ code: e.code, message: e.message, severity: 'blocking', system: !!e.system });
    }
  }
  line.status = line.reasons.some((r) => r.system) ? 'failed' : 'review';
  line.exceptionCategory = categorize(line.reasons);
  line.producedUnits = 0;
}

export async function analyzeAll(lines: LineDraft[], ctx: PipelineContext): Promise<void> {
  const cache = new Map<number, IconIndex>();
  for (const line of lines) {
    await analyzeLine(line, ctx, cache);
  }
}

export async function runPipeline(
  lines: LineDraft[],
  ctx: PipelineContext,
  meta: RunMeta,
  python: PythonRunner,
  options: { skipAnalyze?: boolean; render?: boolean } = {},
): Promise<PipelineOutput> {
  if (!options.skipAnalyze) await analyzeAll(lines, ctx);
  const unitByKey = () => {
    const map = new Map<string, { line: LineDraft; unit: ProductionUnit }>();
    for (const line of lines) for (const unit of line.units) map.set(unit.unitKey, { line, unit });
    return map;
  };

  // 布局计划：最多迭代 3 次（转为待核对的行会改变连单提醒和页码，需要重排）
  for (let iteration = 0; iteration < 3; iteration++) {
    for (const line of lines) {
      if (line.status === 'pending' || line.status === 'produced') {
        line.status = 'produced';
        line.producedUnits = line.units.length;
      }
    }
    const { slides, fonts } = buildSlides(lines, ctx, meta);
    const production = slides.filter((s) => s.kind === 'production');
    if (!production.length) break;
    const plan = await python({ mode: 'plan', fonts, slides: production });
    if (!plan?.success) throw new Error(`排版计划失败：${plan?.message || '未知错误'}`);
    const map = unitByKey();
    let changed = false;
    for (const p of plan.slides || []) {
      const hit = map.get(p.key);
      if (!hit) continue;
      hit.unit.render = { plan: p.name || null };
      if (!p.ok) {
        markFromPlanErrors(hit.line, p.errors || []);
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const line of lines) {
    if (line.status === 'pending') {
      line.status = 'produced';
      line.producedUnits = line.units.length;
    }
  }
  const { slides, fonts } = buildSlides(lines, ctx, meta);
  let pptBase64: string | null = null;
  let reports: any[] = [];
  if (options.render !== false && slides.length) {
    const result = await python({ mode: 'render', fonts, slides });
    if (!result?.success) throw new Error(`PPT 渲染失败：${result?.message || '未知错误'}`);
    pptBase64 = result.data;
    reports = result.reports || [];
    const map = unitByKey();
    reports.forEach((report, i) => {
      const slide = slides[i];
      const hit = map.get(report.key);
      if (hit) {
        hit.unit.slideNumber = i + 1;
        hit.unit.render = { ...(hit.unit.render || {}), iconsExpected: report.iconsExpected, iconsInserted: report.iconsInserted, nameRendered: report.nameRendered };
        hit.line.producedSlides.push(i + 1);
        if (report.iconsInserted !== report.iconsExpected || report.error || (slide.kind === 'production' && !report.nameRendered)) {
          hit.line.reasons.push({
            code: report.error ? 'generation_failed' : 'icon_insert_failed',
            message: report.error
              ? `第 ${i + 1} 页生成出错：${report.error}`
              : `第 ${i + 1} 页图标应插入 ${report.iconsExpected} 个，实际 ${report.iconsInserted} 个${report.iconErrors?.length ? '（' + report.iconErrors.join('；') + '）' : ''}`,
            severity: 'blocking',
            system: true,
          });
          hit.line.status = 'failed';
          hit.line.exceptionCategory = categorize(hit.line.reasons);
        }
      }
    });
  }

  const linesTotal = lines.length;
  const unitsProduced = lines.reduce((n, l) => n + (l.status === 'produced' ? l.producedUnits : 0), 0);
  return {
    pptBase64,
    lines,
    slides,
    reports,
    stats: {
      linesTotal,
      unitsProduced,
      slidesTotal: slides.length,
      placeholders: slides.filter((s) => s.kind === 'placeholder').length,
      exceptionLines: lines.filter((l) => l.exceptionCategory).length,
      warningLines: lines.filter((l) => l.warnings.length).length,
    },
  };
}
