import { IconIndex } from './icon-index';
import { decodeEntities } from './variation-parser';
import { ParsedField, ParsedIcon, ParsedItem, Reason } from './types';

/**
 * 规则解析拆不开时才调用 LLM；LLM 的结果必须通过校验才采用：
 * - 名字必须是顾客原文（Variations）的连续子串，大小写、重音、空格都要一致
 * - 图标必须是当前 SKU 图标组里的完整编号 / 名称 / 别名（整词匹配，不拆字母）
 * - 位置只能是已知的位置 key 或空
 * - 件数要和规则层的要求一致（由调用方再做数量校验）
 * 校验不过 → 保持待核对，不兜底。
 */

export const LLM_RETRY_CODES = new Set([
  'free_text',
  'no_personalization',
  'no_name',
  'names_icons_mixed',
  'no_label',
  'name_or_icon',
]);

export const LLM_SYSTEM_PROMPT = `你是订单定制内容解析助手。从 Variations 原文中提取每一件商品的名字和图标，只输出 JSON：
{"items":[{"name":"原文中的名字","icons":["图标编号或名称"],"position":null}]}
规则：
1. name 必须原样摘抄原文中的连续文字，不改大小写、不改拼写、不加空格；没有名字时为 null。
2. icons 只能从给定的"可用图标"列表中选，按顾客书写顺序列出，重复的要重复列出（white flower, white flower 是两个）。
3. 图标编号是完整的整体（ZF、ZB、A1、C10），绝对不要拆成单个字母或只取数字。
4. 顾客没有写图标时 icons 为空数组；不要猜测。
5. position 只能是 top_left、top_right、bottom_left、bottom_right、name_left、name_right 之一或 null。
6. 照片数量（如 "5 files"）不是商品件数。
7. 只输出 JSON，不要任何解释。`;

export type LlmCall = (userPrompt: string, systemPrompt: string) => Promise<any>;

const POSITIONS = new Set(['top_left', 'top_right', 'bottom_left', 'bottom_right', 'name_left', 'name_right']);

export interface LlmValidation {
  ok: boolean;
  items: ParsedItem[];
  errors: string[];
}

// 顾客写的说明文字、商品名，不能当名字（真实数据里 LLM 曾把 "Lunch Bag"、"no name just flowers ... pls" 当成名字）
const NOT_A_NAME = /\b(please|pls|plz|thanks?|thank you|same as|no name|just|backpack|lunch ?bag|bag|basket|set|colou?r|flowers?|icons?|name)\b/i;

/** 名字只能出自定制 / 名字字段（或没有标签的续行），不能出自款式、颜色等选项字段 */
function nameSourceTexts(fields: ParsedField[] | undefined, original: string): string[] {
  if (!fields || fields.length === 0) return [original];
  return fields
    .filter((f) => !f.label || f.role === 'personalization' || f.role === 'name' || f.role === 'name_icon')
    .map((f) => decodeEntities(f.value));
}

export function validateLlmItems(result: any, variationsRaw: string, index: IconIndex, fields?: ParsedField[]): LlmValidation {
  const errors: string[] = [];
  const original = decodeEntities(variationsRaw);
  const sources = nameSourceTexts(fields, original);
  const rawItems = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : null;
  if (!rawItems) return { ok: false, items: [], errors: ['LLM 返回格式不正确'] };
  const items: ParsedItem[] = [];
  for (const raw of rawItems) {
    const name = raw?.name === null || raw?.name === undefined || raw?.name === '' ? null : String(raw.name);
    if (name !== null && !original.includes(name)) {
      errors.push(`名字 "${name}" 不是原文的子串`);
    } else if (name !== null && !sources.some((text) => text.includes(name))) {
      errors.push(`名字 "${name}" 不在定制 / 名字字段里（取自款式或颜色等选项）`);
    }
    if (name !== null && (name.trim().split(/\s+/).length > 4 || NOT_A_NAME.test(name))) {
      errors.push(`名字 "${name}" 像是说明文字或商品名，不像名字`);
    }
    if (name !== null && /^\d+$/.test(name.trim())) errors.push(`名字 "${name}" 是纯数字`);
    const icons: ParsedIcon[] = [];
    for (const iconRaw of Array.isArray(raw?.icons) ? raw.icons : []) {
      const text = String(iconRaw ?? '').trim();
      const found = index.lookup(text);
      if (found.status !== 'ok') {
        errors.push(found.status === 'ambiguous' ? `图标 "${text}" 在图标组里有歧义` : `图标 "${text}" 不在 SKU 图标组内`);
        continue;
      }
      const position = raw?.position && POSITIONS.has(String(raw.position)) ? String(raw.position) : null;
      if (raw?.position && !position) errors.push(`位置 "${raw.position}" 不是已知位置`);
      icons.push({
        raw: text,
        iconId: found.entry!.id,
        iconName: found.entry!.code || found.entry!.name,
        kind: found.entry!.kind || 'large',
        filePath: found.entry!.filePath,
        fileExists: found.entry!.fileExists,
        position,
        positionRaw: raw?.position ? String(raw.position) : null,
      });
    }
    items.push({ name: name ? name : null, icons, component: null });
  }
  if (!items.some((i) => i.name)) errors.push('LLM 没有给出名字');
  return { ok: errors.length === 0, items, errors };
}

export async function tryLlmFallback(
  llm: LlmCall | null,
  variationsRaw: string,
  index: IconIndex,
  fields?: ParsedField[],
): Promise<{ used: boolean; validation?: LlmValidation; reason?: Reason }> {
  if (!llm) {
    return { used: false, reason: { code: 'llm_unavailable', message: '规则无法拆分，且未配置 LLM，保持待核对', severity: 'warning' } };
  }
  const iconNames = index.entries.map((e) => e.code || e.name);
  const userPrompt = `可用图标：${JSON.stringify(iconNames)}\nVariations 原文：\n${decodeEntities(variationsRaw)}`;
  try {
    const result = await llm(userPrompt, LLM_SYSTEM_PROMPT);
    const validation = validateLlmItems(result, variationsRaw, index, fields);
    return { used: true, validation };
  } catch (error) {
    return {
      used: false,
      reason: { code: 'llm_unavailable', message: `LLM 调用失败（${(error as Error)?.message || '未知错误'}），保持待核对`, severity: 'warning' },
    };
  }
}
