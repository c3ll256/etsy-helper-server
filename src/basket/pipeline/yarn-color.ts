import { LayoutSlot, ParsedIcon } from './types';

export interface YarnColorResult {
  icons: Array<ParsedIcon & { slot?: LayoutSlot }>;
  summary: string | null;
}

function norm(color: string): string {
  return String(color || '').trim().toLowerCase();
}

function slotSideAndX(slot?: LayoutSlot): { side: 'left' | 'right'; x: number } {
  if (!slot) return { side: 'right', x: 100 };
  if (slot.anchor === 'name_left') return { side: 'left', x: 0 };
  if (slot.anchor === 'name_right') return { side: 'right', x: 100 };
  const cx = (slot.x ?? 50) + (slot.w ?? 0) / 2;
  return { side: cx < 50 ? 'left' : 'right', x: cx };
}

/**
 * 混色名字 + 毛线款图标自动算色（3.1.4）：
 * 1. 先按名字里的有效字母/数字循环配色，得到首字母色、尾字母色、以及名字结束后的下一个色；
 * 2. 将毛线款图标（kind === 'yarn'）按落位从左到右排列，顺着往下取色；
 * 3. 若图标在左侧且与首字母撞色、或在右侧且与尾字母撞色，则跳一个色。
 */
export function assignYarnIconColors(
  name: string | null,
  sequence: string[] | null | undefined,
  icons: Array<ParsedIcon & { slot?: LayoutSlot }>,
): YarnColorResult {
  const cleanSeq = (sequence || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (cleanSeq.length < 2 || !name) return { icons, summary: null };
  const yarnIndices = icons
    .map((icon, index) => ({ icon, index, pos: slotSideAndX(icon.slot) }))
    .filter((entry) => entry.icon.kind === 'yarn');
  if (!yarnIndices.length) return { icons, summary: null };

  const letters = name.match(/[\p{L}\p{N}]/gu) || [];
  if (!letters.length) return { icons, summary: null };

  const firstColor = cleanSeq[0];
  const lastColor = cleanSeq[(letters.length - 1) % cleanSeq.length];
  let idx = letters.length % cleanSeq.length;

  // 从左到右依次配色
  const ordered = [...yarnIndices].sort((a, b) => a.pos.x - b.pos.x || a.index - b.index);
  const out = icons.map((icon) => ({ ...icon }));
  const parts: string[] = [];

  for (const entry of ordered) {
    const adjacentColor = entry.pos.side === 'left' ? firstColor : lastColor;
    let skipped = false;
    if (norm(cleanSeq[idx]) === norm(adjacentColor)) {
      idx = (idx + 1) % cleanSeq.length;
      skipped = true;
    }
    const chosen = cleanSeq[idx];
    out[entry.index] = {
      ...out[entry.index],
      yarnColor: chosen,
      yarnColorNote: skipped ? `与临近字母(${adjacentColor})撞色，跳一色` : null,
    };
    parts.push(`${entry.icon.iconName}→${chosen}${skipped ? '(跳色)' : ''}`);
    idx = (idx + 1) % cleanSeq.length;
  }

  return {
    icons: out,
    summary: parts.length ? `毛线图标配色（从左到右）：${parts.join('、')}` : null,
  };
}
