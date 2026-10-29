import { IconIndex, normIconKey, singular } from './icon-index';
import { isKnownLabel, matchLabelPrefix, roleOfLabel } from './variation-labels';
import { FieldRole, ParsedField, ParsedIcon, ParsedItem, ParseResult, Reason } from './types';

/**
 * 母婴 Variations 规则解析器（先规则、后 LLM 的"规则"部分）。
 *
 * 1. 切分字段：兼容新版（按换行分隔、标签与值紧连）和旧版（`标签:值,标签:值`）格式，原文完整保留在 fields 里
 * 2. 从名字 / 图标 / 个性化字段里提取每件商品的名字和图标：
 *    - 名字只取顾客原文的子串，保留拼写、大小写、重音、空格、连字符和撇号
 *    - 图标只在当前 SKU 关联的图标组内按完整编号 / 名称 / 别名匹配，保留重复和顺序
 *    - "5 files" 这类附件字段只作为附件说明，不当成件数
 * 3. 拆不开、有歧义、带说明文字时，不猜，给出待核对原因
 */

export function decodeEntities(text: string): string {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const blocking = (code: string, message: string, system = false): Reason => ({ code, message, severity: 'blocking', system });
const warning = (code: string, message: string): Reason => ({ code, message, severity: 'warning' });

// ---------------------------------------------------------------- 字段切分

const FREE_TEXT_ROLES: FieldRole[] = ['personalization', 'name_icon'];
/** 个性化之后仍可开始新字段的标签（真实数据里个性化后面会跟 2. Icon 等编号字段） */
const AFTER_FREE_TEXT_ALLOWED: FieldRole[] = ['icon', 'color', 'attachment'];

export function splitFields(raw: string): { format: ParseResult['format']; fields: ParsedField[] } {
  const text = decodeEntities(raw).replace(/\r\n?/g, '\n');
  if (!text.trim()) return { format: 'empty', fields: [] };

  // 旧格式：以"标签:"开头（换行只出现在值里）
  const first = text.match(/^\s*([^\n:,]{1,80}?)\s*:/);
  const isComma = !!first && (isKnownLabel(first[1]) || /,[^,:\n]{1,80}:/.test(text));
  if (isComma) return { format: 'comma', fields: splitComma(text) };
  if (!text.includes('\n')) {
    // 逗号分隔但标签后没有冒号：Backpack ColorBlue,Yarn ColorMix-1,PersonalizationLucas, 15 and 21
    const commaSplit = splitGluedComma(text);
    if (commaSplit) return { format: 'comma', fields: splitNewline(commaSplit) };
    const m = matchLabelPrefix(text);
    if (m) return { format: 'single', fields: [{ label: m.label, role: m.role, value: text.slice(m.length) }] };
    return { format: 'single', fields: [{ label: null, role: 'option', value: text }] };
  }
  return { format: 'newline', fields: splitNewline(text) };
}

function splitGluedComma(text: string): string | null {
  if (!matchLabelPrefix(text)) return null;
  let out = '';
  let changed = false;
  let inFree = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ',' && !inFree) {
      const m = matchLabelPrefix(text.slice(i + 1));
      if (m) {
        out += '\n';
        changed = true;
        if (FREE_TEXT_ROLES.includes(m.role)) inFree = true;
        continue;
      }
    }
    out += ch;
  }
  if (matchLabelPrefix(text) && FREE_TEXT_ROLES.includes(matchLabelPrefix(text)!.role)) return null;
  return changed ? out : null;
}

function splitComma(text: string): ParsedField[] {
  const fields: ParsedField[] = [];
  const re = /(^|,)\s*([^,:\n]{1,80}?)\s*:/g;
  const marks: Array<{ start: number; valueStart: number; label: string }> = [];
  let inFree = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const label = m[2].trim();
    const role = roleOfLabel(label);
    if (inFree && !(isKnownLabel(label) && AFTER_FREE_TEXT_ALLOWED.includes(role))) continue;
    marks.push({ start: m.index, valueStart: m.index + m[0].length, label });
    if (FREE_TEXT_ROLES.includes(role)) inFree = true;
  }
  if (!marks.length || marks[0].start > 0) {
    const end = marks.length ? marks[0].start : text.length;
    if (text.slice(0, end).trim()) fields.push({ label: null, role: 'option', value: text.slice(0, end) });
  }
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    fields.push({ label: mark.label, role: roleOfLabel(mark.label), value: text.slice(mark.valueStart, end) });
  });
  return fields;
}

function splitNewline(text: string): ParsedField[] {
  const fields: ParsedField[] = [];
  let inFree = false;
  for (const line of text.split('\n')) {
    const m = matchLabelPrefix(line);
    if (m && (!inFree || AFTER_FREE_TEXT_ALLOWED.includes(m.role) && /^\s*\d\s*[.)]/.test(line))) {
      fields.push({ label: m.label, role: m.role, value: line.slice(m.length) });
      inFree = FREE_TEXT_ROLES.includes(m.role);
      continue;
    }
    if (fields.length) {
      const last = fields[fields.length - 1];
      last.value = last.value + '\n' + line;
    } else {
      fields.push({ label: null, role: 'option', value: line });
    }
  }
  return fields;
}

// ---------------------------------------------------------------- 位置

const POSITION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(top|upper)[\s-]*right\b|\bright[\s-]*(top|upper)\b|oben rechts/i, 'top_right'],
  [/\b(top|upper)[\s-]*left\b|\bleft[\s-]*(top|upper)\b|oben links/i, 'top_left'],
  [/\b(bottom|lower)[\s-]*right\b|\bright[\s-]*(bottom|lower)\b|unten rechts/i, 'bottom_right'],
  [/\b(bottom|lower)[\s-]*left\b|\bleft[\s-]*(bottom|lower)\b|unten links/i, 'bottom_left'],
  [/\b(left of|before)\s+(the\s+)?name\b|\bname'?s? left\b/i, 'name_left'],
  [/\b(right of)\s+(the\s+)?name\b|\bname'?s? right\b/i, 'name_right'],
  [/\b(after|behind|next to|beside)\s+(the\s+)?(name|names)\b|名字后面/i, 'name_after'],
];
const POSITION_WORDS = /\b(top|bottom|left|right|corner|center|centre|middle|above|below|under|underneath|side|before|after|behind|next to|beside|placed|position|oben|unten|links|rechts)\b/i;

export function detectPosition(text: string): { key: string | null; raw: string | null; unknown: boolean } {
  const t = String(text || '');
  for (const [re, key] of POSITION_PATTERNS) {
    const m = t.match(re);
    if (m) return { key, raw: m[0], unknown: false };
  }
  if (POSITION_WORDS.test(t)) return { key: null, raw: t.trim(), unknown: true };
  return { key: null, raw: null, unknown: false };
}

// ---------------------------------------------------------------- 名字 / 图标

const NO_ICON = /^(no\s*(icons?|symbols?|designs?|pictures?)(,?\s*(just|only)\s*(the\s*)?name)?|(just|only)\s*(the\s*)?names?|names?\s*only|none|n\/?a|no|nothing|sans (ic[oô]ne|symbole)|kein(e)? symbol(e)?|ohne symbol)$/i;
const FILLER = /^(thank(s| you)( so much)?|please|pls|danke|merci|gracias|ty|x+o*|xo)$/i;
const INSTRUCTION_WORDS = /\b(please|pls|thank|thanks|want|would|like|could|can you|lowercase|uppercase|capital|letters?|colou?r|yarn|bag|basket|backpack|side|line|lines|font|same|both|each|all|icon|icons|symbol|design|image|photo|picture|gift|birthday|ship|order|danke|bitte|merci|svp)\b/i;
const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1 };
const FLOWER_WORDS = /^(flowers?|blumen?|fleurs?|flores?)$/i;

interface PartClass {
  kind: 'name' | 'icons' | 'no_icon' | 'filler' | 'position' | 'unknown';
  text: string;
  icons?: ParsedIcon[];
  reasons?: Reason[];
  positionKey?: string | null;
  positionRaw?: string | null;
}

/** 解析一个图标写法：编号 / 名称 / 别名，可带数量（two white flowers、x2、- 2 icons）和描述（22 lion） */
function parseIconToken(token: string, index: IconIndex): { icons: ParsedIcon[]; reasons: Reason[] } | null {
  let t = token.trim().replace(/^(icons?|symbols?|designs?|design choices?|number|no\.?|nr\.?|#)\s*[:#.\-]?\s*/i, '').replace(/^#\s*/, '').trim();
  t = t.replace(/\s*[-–]?\s*\b(icons?|symbols?)\b\s*$/i, '').trim();
  if (!t) return null;
  const reasons: Reason[] = [];
  let count = 1;
  let explicitCount = false;
  const suffixCount = t.match(/^(.*?)\s*(?:[-–x×*]\s*(\d)|\((\d)\))\s*$/i);
  if (suffixCount && suffixCount[1] && /\D/.test(suffixCount[1])) {
    const direct = index.lookup(t);
    if (direct.status === 'none') {
      t = suffixCount[1].trim();
      count = Number(suffixCount[2] || suffixCount[3]);
      explicitCount = true;
    }
  }
  const asIs = index.lookup(t);
  if (asIs.status === 'ok') return { icons: repeat(asIs.entry!, t, count), reasons };
  if (asIs.status === 'ambiguous') {
    return { icons: [], reasons: [blocking('icon_ambiguous', `图标 "${t}" 在图标组里有 ${asIs.candidates!.length} 个同名词条（${asIs.candidates!.map((c) => c.name).join(' / ')}），请核对`)] };
  }

  const words = t.split(/\s+/);
  // 数量词前缀：two white flowers / 2 white flowers / 2x bow
  const lead = words[0].toLowerCase().replace(/x$/, '');
  if (words.length >= 2 && (COUNT_WORDS[lead] !== undefined || /^\d$/.test(lead))) {
    const rest = words.slice(1).join(' ');
    const restLookup = lookupWithPlural(rest, index);
    const leadIsCode = /^\d+$/.test(lead) && index.lookup(lead).status !== 'none';
    if (restLookup && !leadIsCode) {
      const n = COUNT_WORDS[lead] ?? Number(lead);
      return { icons: repeat(restLookup.entry, t, n), reasons };
    }
  }
  // 复数：Flowers 表示两朵（明确写了数量的不再翻倍）
  const plural = lookupWithPlural(t, index);
  if (plural) {
    const lastWord = words[words.length - 1];
    if (plural.plural) {
      if (FLOWER_WORDS.test(lastWord)) {
        if (/^\d/.test(t) && !explicitCount) {
          reasons.push(blocking('icon_plural_count', `"${t}" 带编号又写成复数，图标数量需要核对`));
          return { icons: repeat(plural.entry, t, 1), reasons };
        }
        return { icons: repeat(plural.entry, t, explicitCount ? count : 2), reasons };
      }
      reasons.push(blocking('icon_plural_count', `"${t}" 是复数写法，图标数量需要核对`));
      return { icons: repeat(plural.entry, t, count), reasons };
    }
    return { icons: repeat(plural.entry, t, count), reasons };
  }
  // 编号 + 描述：22 lion、02 white flowers、D12 pink butterfly
  if (words.length >= 2) {
    const head = index.lookup(words[0]);
    if (head.status === 'ok') {
      const desc = words.slice(1).join(' ');
      if (index.describes(head.entry!, desc)) {
        const lastWord = words[words.length - 1];
        if (/s$/i.test(lastWord) && FLOWER_WORDS.test(lastWord)) {
          reasons.push(blocking('icon_plural_count', `"${t}" 带编号又写成复数，图标数量需要核对`));
        }
        return { icons: repeat(head.entry!, t, count), reasons };
      }
      return { icons: repeat(head.entry!, t, count), reasons: [blocking('icon_desc_mismatch', `"${t}"：编号 ${words[0]} 对应 ${head.entry!.name}，但附带的描述 "${desc}" 对不上，请核对`)] };
    }
  }
  return null;
}

function lookupWithPlural(text: string, index: IconIndex): { entry: any; plural: boolean } | null {
  const direct = index.lookup(text);
  if (direct.status === 'ok') return { entry: direct.entry, plural: false };
  const words = text.trim().split(/\s+/);
  const last = words[words.length - 1];
  const sing = singular(last);
  if (sing !== last.toLowerCase()) {
    const s = index.lookup([...words.slice(0, -1), sing].join(' '));
    if (s.status === 'ok') return { entry: s.entry, plural: true };
  }
  return null;
}

function repeat(entry: any, raw: string, n: number): ParsedIcon[] {
  return Array.from({ length: Math.max(1, Math.min(n, 9)) }, () => ({
    raw,
    iconId: entry.id,
    iconName: entry.code || entry.name,
    kind: entry.kind || 'large',
    filePath: entry.filePath,
    fileExists: entry.fileExists,
    position: null,
    positionRaw: null,
  }));
}

/** 一段文字可能是几个图标：13 and 23、1 & 7、F2 and Bow、strawberry and rabbit */
function parseIconList(text: string, index: IconIndex): { icons: ParsedIcon[]; reasons: Reason[] } | null {
  const whole = parseIconToken(text, index);
  if (whole && !whole.reasons.some((r) => r.code === 'icon_desc_mismatch')) return whole;
  const split = parseIconPieces(text, index);
  if (split) return split;
  return whole;
}

function parseIconPieces(text: string, index: IconIndex): { icons: ParsedIcon[]; reasons: Reason[] } | null {
  const pieces = text.split(/\s+(?:and|und|et|y|e|plus)\s+|\s*[&+\/]\s*/i).map((p) => p.trim()).filter(Boolean);
  const spaced = pieces.length === 1 ? text.trim().split(/\s+/) : null;
  const candidates = pieces.length > 1 ? pieces : spaced && spaced.length > 1 ? spaced : null;
  if (!candidates) return null;
  const icons: ParsedIcon[] = [];
  const reasons: Reason[] = [];
  for (const piece of candidates) {
    const r = parseIconToken(piece, index);
    if (!r || (!r.icons.length && !r.reasons.length)) return null;
    icons.push(...r.icons);
    reasons.push(...r.reasons);
  }
  return { icons, reasons };
}

function classifyPart(partRaw: string, index: IconIndex, roleHint: 'name' | 'icon' | null): PartClass {
  let text = partRaw.trim();
  const out: PartClass = { kind: 'unknown', text };
  if (!text) return { kind: 'filler', text };
  if (FILLER.test(text.replace(/[!.,:)( ❤️♥😊🙂]+/gu, ' ').trim())) return { kind: 'filler', text };

  // 括号：位置或描述
  let positionKey: string | null = null;
  let positionRaw: string | null = null;
  const parens = [...text.matchAll(/[（(]([^()（）]*)[)）]/g)].map((m) => m[1]);
  let stripped = text.replace(/[（(][^()（）]*[)）]/g, ' ').replace(/\s+/g, ' ').trim();
  const reasons: Reason[] = [];
  for (const p of parens) {
    const pos = detectPosition(p);
    if (pos.key) {
      positionKey = pos.key;
      positionRaw = pos.raw;
    } else if (pos.unknown) {
      reasons.push(blocking('position_unknown', `位置描述 "${p.trim()}" 无法对应到布局位置，请核对`));
    }
  }
  // 行内位置短语：#20 placed on bottom right
  const inlinePos = detectPosition(stripped);
  if (inlinePos.key) {
    positionKey = inlinePos.key;
    positionRaw = inlinePos.raw;
    stripped = stripped.replace(new RegExp(`\\b(placed\\s+)?(on|at|in)?\\s*(the\\s+)?${escapeRe(inlinePos.raw!)}(\\s+(corner|side))?`, 'i'), ' ').replace(/\s+/g, ' ').trim();
  }

  if (!stripped) {
    return { kind: positionKey || reasons.length ? 'position' : 'filler', text, positionKey, positionRaw, reasons };
  }
  if (NO_ICON.test(stripped.replace(/[!.,]+$/, '').trim())) return { kind: 'no_icon', text };

  const roleName = /^(name|names|nom|prénom|prenom|vorname|nombre|name on bag)\s*[:\-–]\s*/i;
  const roleIcon = /^(icons?|symbols?|designs?|design choices?|icon choices?|flowers?)\s*[:\-#]\s*|^(icons?|symbols?)\s+/i;
  // "Yarn: Cream" / "Color: pink"：颜色说明，记入备注，不当名字
  if (/^(yarn|yarn colou?r|colou?r|couleur|farbe)\s*:/i.test(stripped)) {
    return { kind: 'filler', text, reasons: [warning('color_note_in_personalization', `个性化里写了颜色说明 "${stripped}"，已保留原文，请核对`)] };
  }
  let hint = roleHint;
  if (roleName.test(stripped)) {
    stripped = stripped.replace(roleName, '').trim();
    hint = 'name';
  } else if (roleIcon.test(stripped) && !/^(icons?|symbols?|designs?)\s*$/i.test(stripped)) {
    hint = 'icon';
    if (/^flowers?\s*:/i.test(stripped)) stripped = stripped.replace(/^flowers?\s*:\s*/i, '');
  }

  if (hint !== 'name') {
    const icons = parseIconList(stripped, index);
    if (icons && (icons.icons.length || icons.reasons.length)) {
      if (positionKey && icons.icons.length) {
        icons.icons.forEach((icon) => {
          icon.position = positionKey;
          icon.positionRaw = positionRaw;
        });
      }
      return { kind: 'icons', text, icons: icons.icons, reasons: [...reasons, ...icons.reasons] };
    }
    if (hint === 'icon') {
      const cleaned = stripped.replace(roleIcon, '').trim();
      return {
        kind: 'unknown',
        text,
        reasons: [...reasons, index.size ? blocking('icon_not_found', `图标 "${cleaned}" 不在该 SKU 的图标组内`) : blocking('icon_group_missing', `SKU 没有关联图标组，无法识别图标 "${cleaned}"（配置问题）`, true)],
      };
    }
  }

  // 像编号的短词（含数字，或不含元音的 1–4 个字母，例如 BDK、ZF）：不在图标组里就不能当名字
  if (/^[A-Za-z]*\d[A-Za-z0-9]*$/.test(stripped) && stripped.length <= 4 || /^[B-DF-HJ-NP-TV-XZ]{1,4}$/.test(stripped)) {
    return {
      kind: 'unknown',
      text,
      reasons: [...reasons, index.size ? blocking('icon_not_found', `"${stripped}" 像图标编号，但不在该 SKU 的图标组内（不会拆成单个字母）`) : blocking('icon_group_missing', `"${stripped}" 像图标编号，但 SKU 没有关联图标组（配置问题）`, true)],
    };
  }
  // 名字：必须含字母；不能是纯数字
  if (!/\p{L}/u.test(stripped)) {
    return {
      kind: 'unknown',
      text,
      reasons: [...reasons, index.size ? blocking('icon_not_found', `"${stripped}" 不是名字，也不在图标组内`) : blocking('icon_group_missing', `"${stripped}" 像是图标编号，但 SKU 没有关联图标组（配置问题）`, true)],
    };
  }
  if (positionKey) {
    reasons.push(blocking('position_on_name', `名字 "${stripped}" 附带位置说明 "${positionRaw}"，请核对`));
  }
  const words = stripped.split(/\s+/);
  if (words.length > 4 || INSTRUCTION_WORDS.test(stripped) && hint !== 'name') {
    return { kind: 'unknown', text, reasons: [...reasons, blocking('free_text', `定制内容含说明文字 "${stripped}"，请核对`)] };
  }
  if (POSITION_WORDS.test(stripped) && hint !== 'name') {
    return { kind: 'unknown', text, reasons: [...reasons, blocking('position_unknown', `"${stripped}" 含位置描述，无法自动识别`)] };
  }
  // 名字后面直接跟带数字的完整编号（"Talia 22"、"Geordi D7"、"Andi F1 and K1"）：带数字的编号不可能是名字的一部分，拆开
  if (words.length >= 2) {
    for (let cut = 1; cut < words.length; cut++) {
      const head = words.slice(0, cut).join(' ');
      const tail = words.slice(cut).join(' ');
      if (!/^[\p{L}][\p{L}.'’\- ]*$/u.test(head)) break;
      const tailTokens = tail.split(/\s*(?:\band\b|&|,|\s)\s*/i).filter(Boolean);
      if (!tailTokens.length || !tailTokens.every((t) => /\d/.test(t))) continue;
      const parsed = parseIconPieces(tail, index) || parseIconToken(tail, index);
      if (parsed && parsed.icons.length && !parsed.reasons.length) {
        return { kind: 'name', text: trimNamePunct(head), icons: parsed.icons, reasons };
      }
    }
  }
  // 名字末尾是单个字符的有效图标编号（例如 "Anayah K"）：可能是名字缩写，也可能是图标
  if (words.length >= 2) {
    const last = words[words.length - 1];
    if (last.length <= 2 && index.lookup(last).status === 'ok') {
      reasons.push(blocking('name_or_icon', `"${stripped}" 末尾的 "${last}" 可能是图标编号，也可能是名字的一部分，请核对`));
    }
  }
  // 名字里夹着数字（"Kaysan 22 lion"）：可能混入了图标编号，不当成名字直接做
  if (/\d/.test(stripped)) {
    reasons.push(blocking('name_has_digits', `"${stripped}" 含数字，可能混入了图标编号或说明，请核对`));
  }
  // 原文子串（去掉首尾标点）
  const name = trimNamePunct(stripped);
  return { kind: 'name', text: name, reasons };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimNamePunct(s: string): string {
  return s.replace(/^[\s"“”'‘’:;,.\-–]+(?=\p{L})/u, '').replace(/[\s"“”:;,.]+$/u, '').trim();
}

/** 套组内某个组成件的段落标题：Backpack: / Lunch kit: / 2nd basket: */
const SECTION_HEADER = /^\s*((?:\d+(?:st|nd|rd|th)|first|second|third)\s+[\p{L} ]{2,20}|backpack|book ?bag|school ?bag|lunch ?(?:bag|box|kit)|lunchbag|lunchbox|pencil ?case|pouch|basket\s*\d?|bag\s*\d|set\s*\d|item\s*\d|\d)\s*[:：]\s*$/iu;

interface Segment {
  header: string | null;
  lines: string[];
}

function splitSections(text: string): Segment[] {
  const segments: Segment[] = [{ header: null, lines: [] }];
  for (const line of text.split('\n')) {
    if (SECTION_HEADER.test(line)) {
      segments.push({ header: line.replace(/[:：]\s*$/, '').trim(), lines: [] });
    } else {
      segments[segments.length - 1].lines.push(line);
    }
  }
  return segments.filter((s) => s.header !== null || s.lines.some((l) => l.trim()));
}

/** 单行里的编号分隔："1. Rayla, 1 2. Jack, 3" / "1st Annie C 2nd Tabitha C" */
function splitEnumerated(line: string): string[] {
  const parts = line.split(/(?:^|\s+)(?=(?:\d{1,2}\s*[.)]|\d(?:st|nd|rd|th))\s+\S)/i).map((p) => p.trim()).filter(Boolean);
  return parts
    .map((p) => p.replace(/^(?:\d{1,2}\s*[.)]|\d(?:st|nd|rd|th)|\d{1,2}\s*[-–](?=\s*\S))\s*/i, '').trim())
    .filter(Boolean)
    .map(splitInlineIconMarker);
}

/** "Harper - icon A" / "Selah & icon A" / "Riley Icon- X" → "Harper, icon A"（"No icons" 不拆） */
function splitInlineIconMarker(chunk: string): string {
  return chunk.replace(/([\p{L}.'’-]+)\s*(?:[-–&+]|\band\b)?\s+(icons?|symbols?)\b\s*[:\-–]?\s*(?=\S)/giu, (m, word: string, marker: string) =>
    /^(no|without|sans|ohne|kein|keine|just|only)$/i.test(word) ? m : `${word}, ${marker} `,
  );
}

export interface FreeTextResult {
  items: ParsedItem[];
  reasons: Reason[];
  notes: string[];
  noIcon: boolean;
  sections: string[];
}

/**
 * 解析个性化自由文本。按行分组：每行有名字时这一行是一件商品，图标跟着同一行；只有图标的行归到上一件。
 */
export function parseFreeText(text: string, index: IconIndex, roleHint: 'name' | 'icon' | null = null): FreeTextResult {
  const reasons: Reason[] = [];
  const notes: string[] = [];
  const sections: string[] = [];
  let noIcon = false;
  const allItems: ParsedItem[] = [];

  for (const segment of splitSections(text)) {
    if (segment.header) sections.push(segment.header);
    const items: ParsedItem[] = [];
    let pendingIcons: ParsedIcon[] = [];
    for (const rawLine of segment.lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const chunks = splitEnumerated(line);
      for (const chunk of chunks) {
        const parts = chunk.split(/\s*[,;，、]\s*/).filter((p) => p.trim());
        let lineItem: ParsedItem | null = null;
        let namesInChunk = 0;
        for (const part of parts) {
          const cls = classifyPart(part, index, roleHint);
          if (cls.reasons) reasons.push(...cls.reasons);
          switch (cls.kind) {
            case 'name': {
              namesInChunk++;
              lineItem = { name: cls.text, icons: [...(cls.icons || [])], component: segment.header };
              items.push(lineItem);
              if (pendingIcons.length && items.length === 1) {
                lineItem.icons.push(...pendingIcons);
                pendingIcons = [];
              }
              break;
            }
            case 'icons': {
              const target = lineItem || items[items.length - 1];
              if (target) target.icons.push(...(cls.icons || []));
              else pendingIcons.push(...(cls.icons || []));
              break;
            }
            case 'position': {
              const target = lineItem || items[items.length - 1];
              const lastIcon = target?.icons[target.icons.length - 1] || pendingIcons[pendingIcons.length - 1];
              if (lastIcon && cls.positionKey) {
                lastIcon.position = cls.positionKey;
                lastIcon.positionRaw = cls.positionRaw || null;
              }
              break;
            }
            case 'no_icon':
              noIcon = true;
              notes.push(cls.text);
              break;
            case 'filler':
              if (cls.text.trim()) notes.push(cls.text);
              break;
            default:
              notes.push(cls.text);
          }
        }
        if (namesInChunk > 1 && items.slice(-namesInChunk).some((it) => it.icons.length)) {
          reasons.push(blocking('names_icons_mixed', `"${chunk}" 同一行有 ${namesInChunk} 个名字和图标，无法确定图标属于哪件，请核对`));
        }
      }
    }
    if (pendingIcons.length) {
      if (items.length) items[0].icons.unshift(...pendingIcons);
      else items.push({ name: null, icons: pendingIcons, component: segment.header });
    }
    allItems.push(...items);
  }
  if (noIcon && allItems.some((it) => it.icons.length)) {
    reasons.push(blocking('no_icon_conflict', '顾客写了不要图标，但同时识别到了图标，请核对'));
  }
  return { items: allItems, reasons, notes, noIcon, sections };
}

// ---------------------------------------------------------------- 总入口

export function parseVariations(raw: string, index: IconIndex): ParseResult {
  const { format, fields } = splitFields(raw);
  const reasons: Reason[] = [];
  const notes: string[] = [];
  const attachments: string[] = [];

  const colorFields = fields.filter((f) => f.role === 'color');
  const preferred = colorFields.find((f) => /name colou?r/i.test(f.label || '')) || colorFields[0];
  const colorRaw = preferred ? preferred.value.trim() || null : null;
  const otherColors = colorFields.filter((f) => f !== preferred && f.value.trim() && f.value.trim() !== preferred?.value.trim());
  if (otherColors.length) {
    notes.push(...otherColors.map((f) => `${f.label}: ${f.value.trim()}`));
  }
  for (const f of fields.filter((x) => x.role === 'attachment')) {
    attachments.push(`${f.label}: ${f.value.trim()}`);
  }

  let items: ParsedItem[] = [];
  const nameFields = fields.filter((f) => f.role === 'name');
  const iconFields = fields.filter((f) => f.role === 'icon');
  const freeFields = fields.filter((f) => f.role === 'personalization' || f.role === 'name_icon');

  if (nameFields.length || iconFields.length) {
    for (const f of nameFields) {
      const r = parseFreeText(f.value, index, 'name');
      reasons.push(...r.reasons);
      notes.push(...r.notes);
      items.push(...r.items);
    }
    const icons: ParsedIcon[] = [];
    for (const f of iconFields) {
      const v = f.value.trim();
      if (!v) continue;
      const r = parseFreeText(v, index, 'icon');
      reasons.push(...r.reasons);
      notes.push(...r.notes);
      for (const it of r.items) {
        if (it.name) {
          reasons.push(blocking('icon_not_found', `图标字段 "${v}" 里的 "${it.name}" 不在图标组内`));
        }
        icons.push(...it.icons);
      }
    }
    for (const f of freeFields) {
      const r = parseFreeText(f.value, index, null);
      reasons.push(...r.reasons);
      notes.push(...r.notes);
      items.push(...r.items);
    }
    if (icons.length) {
      if (items.length === 1) items[0].icons.push(...icons);
      else if (items.length === 0) items.push({ name: null, icons, component: null });
      else reasons.push(blocking('names_icons_mixed', `有 ${items.length} 个名字，图标无法对应到具体商品，请核对`));
    }
  } else {
    for (const f of freeFields) {
      const r = parseFreeText(f.value, index, null);
      reasons.push(...r.reasons);
      notes.push(...r.notes);
      items.push(...r.items);
    }
  }
  const unlabeled = !freeFields.length && !nameFields.length && !iconFields.length && fields.length === 1 && !fields[0].label;
  if (unlabeled) {
    // 没有任何标签：按自由文本尝试，但必须人工核对
    const r = parseFreeText(fields[0].value, index, null);
    items.push(...r.items);
    reasons.push(...r.reasons, blocking('no_label', 'Variations 没有可识别的标签，按整段文字尝试拆分，请核对'));
  }

  if (!freeFields.length && !nameFields.length && !iconFields.length && !unlabeled) {
    if (format !== 'empty') reasons.push(blocking('no_personalization', '没有找到个性化 / 名字字段，请按原文核对'));
    else reasons.push(blocking('empty_variations', 'Variations 为空'));
  }
  items = items.filter((it) => it.name || it.icons.length);
  if (!items.some((it) => it.name) && (freeFields.length || nameFields.length)) {
    reasons.push(blocking('no_name', '没有识别出名字，请核对'));
  }
  return {
    format,
    fields,
    items,
    colorRaw,
    colorLabel: preferred?.label || null,
    attachments,
    notes: notes.filter((n) => n && n.trim()),
    reasons: dedupeReasons(reasons),
    source: 'rule',
  };
}

export function dedupeReasons(reasons: Reason[]): Reason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const k = r.code + '|' + r.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export { warning as warningReason, blocking as blockingReason };
export { normIconKey };
