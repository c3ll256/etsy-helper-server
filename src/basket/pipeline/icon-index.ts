import { IconEntry } from './types';

/**
 * 图标组内的完整编号 / 名称 / 别名索引。
 *
 * - 只在当前 SKU 关联的图标组内查找，不跨组
 * - 只做整词匹配：ZF、ZB、A1、C10 都必须整段相同，绝不逐字母拆分，也不退化成只取数字
 * - 匹配时忽略大小写和多余空格；同一组里只差大小写的两个词条（例如 Bow 和 bow 是两张不同的图）
 *   在顾客写法与其中一个大小写完全一致时取那一个，否则视为有歧义
 * - 编号前导零：顾客写 9、组里只有 09（或反过来）时视为同一编号；组里同时有 9 和 09 时有歧义
 * - "02 White Flower" 这类"编号 + 名称"的词条，编号 02 和名称 White Flower 都可以作为写法；
 *   名称在组内不唯一时只认编号
 */
export interface IconLookup {
  status: 'ok' | 'ambiguous' | 'none';
  entry?: IconEntry;
  candidates?: IconEntry[];
}

export function normIconKey(value: string): string {
  return String(value || '')
    .normalize('NFC')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[\s_]+/g, ' ')
    .trim()
    .replace(/[.!?。！？]+$/, '')
    .trim()
    .toLowerCase();
}

function numericKey(key: string): string | null {
  return /^\d+$/.test(key) ? String(parseInt(key, 10)) : null;
}

export class IconIndex {
  private readonly byKey = new Map<string, IconEntry[]>();
  private readonly byNumeric = new Map<string, IconEntry[]>();
  private readonly exactCase = new Map<string, IconEntry[]>();
  readonly entries: IconEntry[];

  constructor(entries: IconEntry[]) {
    this.entries = entries;
    const descKeys = new Map<string, IconEntry[]>();
    for (const entry of entries) {
      const keys = new Set<string>();
      const name = String(entry.name || '');
      keys.add(normIconKey(name));
      if (entry.code) keys.add(normIconKey(entry.code));
      for (const alias of entry.aliases || []) {
        if (alias && alias.trim()) keys.add(normIconKey(alias));
      }
      this.pushTo(this.exactCase, name.trim(), entry);
      for (const alias of entry.aliases || []) this.pushTo(this.exactCase, String(alias).trim(), entry);
      if (entry.code) this.pushTo(this.exactCase, entry.code.trim(), entry);

      // 自动拆出的编号：只有显式 code 为空时才推断
      if (!entry.code) {
        const codeDesc = name.trim().match(/^(\d{1,3})[.\s]+\s*(.+)$/);
        if (codeDesc) {
          keys.add(normIconKey(codeDesc[1]));
          this.pushTo(descKeys, normIconKey(codeDesc[2]), entry);
        }
        const bracket = name.trim().match(/^([A-Za-z0-9]{1,4})\s*[（(][^()（）]*[)）]$/);
        if (bracket) keys.add(normIconKey(bracket[1]));
        const dup = name.trim().match(/^(.+?)\s*\(\d+\)$/);
        if (dup) keys.add(normIconKey(dup[1]));
      }

      for (const key of keys) {
        this.pushTo(this.byKey, key, entry);
        const num = numericKey(key);
        if (num !== null) this.pushTo(this.byNumeric, num, entry);
      }
    }
    for (const [key, list] of descKeys) {
      if (list.length === 1 && !this.byKey.has(key)) this.byKey.set(key, list);
    }
  }

  private pushTo(map: Map<string, IconEntry[]>, key: string, entry: IconEntry) {
    if (!key) return;
    const list = map.get(key) || [];
    if (!list.includes(entry)) list.push(entry);
    map.set(key, list);
  }

  get size(): number {
    return this.entries.length;
  }

  lookup(raw: string): IconLookup {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return { status: 'none' };
    const key = normIconKey(trimmed);
    let list = this.byKey.get(key);
    if (!list || !list.length) {
      const num = numericKey(key);
      if (num !== null) list = this.byNumeric.get(num);
    }
    if (!list || !list.length) return { status: 'none' };
    const distinct = uniqueByFile(list);
    if (distinct.length === 1) return { status: 'ok', entry: distinct[0] };
    const sameCase = uniqueByFile((this.exactCase.get(trimmed) || []).filter((e) => distinct.includes(e)));
    if (sameCase.length === 1) return { status: 'ok', entry: sameCase[0] };
    return { status: 'ambiguous', candidates: distinct };
  }

  /** 名称描述是否和图标本身一致（用于 "22 lion" 这类编号 + 描述的写法） */
  describes(entry: IconEntry, description: string): boolean {
    const words = (s: string) => normIconKey(s).replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter(Boolean).map(singular);
    const desc = new Set(words(description));
    const nameWords = words(String(entry.name || '').replace(/^\d{1,3}[.\s]+/, ''));
    const aliasWords = (entry.aliases || []).map(words);
    const covers = (ws: string[]) => ws.length > 0 && ws.every((w) => desc.has(w) || /^\d+$/.test(w));
    return covers(nameWords) || aliasWords.some(covers) || nameWords.some((w) => desc.has(w) && w.length > 2);
  }
}

function uniqueByFile(list: IconEntry[]): IconEntry[] {
  const seen = new Set<string>();
  const out: IconEntry[] = [];
  for (const e of list) {
    const k = String(e.id);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

export function singular(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 3 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && /(ss|us)$/.test(w)) return w;
  if (w.length > 2 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}
