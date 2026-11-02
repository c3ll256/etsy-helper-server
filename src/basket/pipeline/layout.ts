import { LayoutSlot, LayoutTemplateLike, ParsedIcon, Reason } from './types';

/**
 * 图标布局：按 SKU 选择的布局模板，把一页上的图标分配到模板位置。
 * - 先看模板里有没有和"大图标数 + 彩色小花数"完全一致的组合规则；没有时按模板的默认顺序依次放
 * - 顾客明确指定的位置优先（必须是模板里有的位置）
 * - 位置冲突、没有适用组合、超过位置数时进入待核对，绝不自动增页
 * - "名字后面"（name_after）的含义待确认：不猜，进入待核对
 */

export const SYSTEM_DEFAULT_TEMPLATE: LayoutTemplateLike = {
  id: 0,
  name: '系统默认（右上 → 左下 → 左上 → 右下）',
  slots: [
    { key: 'top_right', label: '右上', anchor: 'absolute', x: 81, y: 21, w: 15, h: 18 },
    { key: 'bottom_left', label: '左下', anchor: 'absolute', x: 4, y: 64, w: 15, h: 18 },
    { key: 'top_left', label: '左上', anchor: 'absolute', x: 4, y: 21, w: 15, h: 18 },
    { key: 'bottom_right', label: '右下', anchor: 'absolute', x: 72, y: 64, w: 15, h: 18 },
  ],
  rules: [],
  defaultOrder: ['top_right', 'bottom_left', 'top_left', 'bottom_right'],
};

export interface SlotAssignment {
  icon: ParsedIcon;
  slot: LayoutSlot;
}

export interface LayoutResult {
  assignments: SlotAssignment[];
  reasons: Reason[];
  ruleLabel: string | null;
}

const review = (code: string, message: string): Reason => ({ code, message, severity: 'blocking' });

export function comboKey(icons: ParsedIcon[]): { large: number; flower: number } {
  let large = 0;
  let flower = 0;
  for (const icon of icons) {
    if (icon.kind === 'flower') flower++;
    else large++;
  }
  return { large, flower };
}

export function assignIconSlots(icons: ParsedIcon[], template: LayoutTemplateLike): LayoutResult {
  const reasons: Reason[] = [];
  if (!icons.length) return { assignments: [], reasons, ruleLabel: null };
  const slotByKey = new Map(template.slots.map((s) => [s.key, s]));
  const { large, flower } = comboKey(icons);

  for (const icon of icons) {
    if (icon.position === 'name_after') {
      reasons.push(review('position_name_after', `顾客要求图标放在"名字后面"（${icon.positionRaw || ''}），该位置的含义待确认，请人工核对`));
    } else if (icon.position && !slotByKey.has(icon.position)) {
      reasons.push(review('position_not_in_template', `顾客指定位置 ${icon.position}（${icon.positionRaw || ''}）不在布局模板"${template.name}"中`));
    }
  }
  if (reasons.length) return { assignments: [], reasons, ruleLabel: null };

  // 1. 组合规则
  const rule = template.rules.find((r) => r.large === large && r.flower === flower);
  let plan: Array<{ slot: string; kind: 'large' | 'flower' | 'any' }> = [];
  let ruleLabel: string | null = null;
  if (rule) {
    plan = rule.placements.map((p) => ({ slot: p.slot, kind: p.kind }));
    ruleLabel = `${large}大${flower ? `+${flower}小花` : ''}`;
    if (rule.requiresReview) {
      reasons.push(review('layout_complex', `组合 ${ruleLabel} 在模板中标记为需人工复核`));
    }
  } else if (template.rules.length && flower > 0) {
    reasons.push(review('layout_no_rule', `布局模板"${template.name}"没有 ${large} 大 + ${flower} 小花的组合规则`));
    return { assignments: [], reasons, ruleLabel: null };
  } else {
    plan = template.defaultOrder.map((slot) => ({ slot, kind: 'any' as const }));
    ruleLabel = '依序';
  }

  if (icons.length > plan.length) {
    reasons.push(review('layout_over_capacity', `图标 ${icons.length} 个，超过布局模板"${template.name}"的 ${plan.length} 个位置`));
    return { assignments: [], reasons, ruleLabel };
  }

  const used = new Set<string>();
  const assignments: SlotAssignment[] = [];
  // 2. 顾客指定的位置优先
  const pinned = icons.filter((i) => i.position);
  for (const icon of pinned) {
    if (used.has(icon.position!)) {
      reasons.push(review('position_conflict', `两个图标都指定了位置 ${icon.position}`));
      continue;
    }
    used.add(icon.position!);
    assignments.push({ icon, slot: slotByKey.get(icon.position!)! });
  }
  // 3. 其余按规则顺序
  for (const icon of icons.filter((i) => !i.position)) {
    const kind = icon.kind === 'flower' ? 'flower' : 'large';
    const next = plan.find((p) => !used.has(p.slot) && (p.kind === 'any' || p.kind === kind));
    if (!next) {
      reasons.push(review('layout_over_capacity', `图标 ${icon.iconName} 没有可用的${kind === 'flower' ? '小花' : '大图标'}位置`));
      continue;
    }
    const slot = slotByKey.get(next.slot);
    if (!slot) {
      reasons.push(review('layout_slot_missing', `布局模板"${template.name}"的规则引用了不存在的位置 ${next.slot}`));
      continue;
    }
    used.add(next.slot);
    assignments.push({ icon, slot });
  }
  // 保留输入顺序
  assignments.sort((a, b) => icons.indexOf(a.icon) - icons.indexOf(b.icon));
  return { assignments, reasons, ruleLabel };
}

/** 校验模板本身：位置坐标在页面内、不和订单详情 / 页脚 / 二维码区域重叠 */
export function validateTemplate(template: Pick<LayoutTemplateLike, 'slots' | 'rules' | 'defaultOrder'>): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const slot of template.slots || []) {
    if (!slot.key) errors.push('位置缺少 key');
    if (keys.has(slot.key)) errors.push(`位置 ${slot.key} 重复`);
    keys.add(slot.key);
    const anchor = slot.anchor || 'absolute';
    if (anchor === 'absolute') {
      const { x = -1, y = -1, w = 0, h = 0 } = slot;
      if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 100 || y + h > 100) errors.push(`位置 ${slot.key} 坐标超出页面`);
      if (y < ZONES.detailsBottom) errors.push(`位置 ${slot.key} 与顶部订单详情区重叠（y 需 ≥ ${ZONES.detailsBottom}%）`);
      if (y + h > ZONES.footerTop) errors.push(`位置 ${slot.key} 与页脚区重叠（y+h 需 ≤ ${ZONES.footerTop}%）`);
    } else if (!slot.size || slot.size <= 0 || slot.size > 40) {
      errors.push(`位置 ${slot.key}（贴名字）需要 size（占页面高度百分比，0–40）`);
    }
  }
  for (const rule of template.rules || []) {
    for (const p of rule.placements || []) {
      if (!keys.has(p.slot)) errors.push(`组合 ${rule.large}大+${rule.flower}小花 引用了不存在的位置 ${p.slot}`);
    }
    const large = (rule.placements || []).filter((p) => p.kind !== 'flower').length;
    const flower = (rule.placements || []).filter((p) => p.kind === 'flower').length;
    if (large !== rule.large || flower !== rule.flower) errors.push(`组合 ${rule.large}大+${rule.flower}小花 的位置数量与组合不一致`);
  }
  for (const k of template.defaultOrder || []) {
    if (!keys.has(k)) errors.push(`默认顺序引用了不存在的位置 ${k}`);
  }
  return errors;
}

/** 页面分区（百分比），与 basket_order_generator.py 中的 ZONES 一致 */
export const ZONES = {
  headerBottom: 14.3, // Tools02 页眉（含二维码）
  detailsBottom: 19.5,
  noticeTop: 84,
  footerTop: 90, // 页脚：处理日期 / 全局编号 / 组内页码
};
