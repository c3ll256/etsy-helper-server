import { IconKind, LayoutRule, LayoutSlot, LayoutTemplateLike, ParsedIcon, PlacementKind, Reason } from './types';

/**
 * 图标布局：按 SKU 选择的布局模板，把一页上的图标分配到模板位置。
 * - 先匹配精确品类组合规则（普通 / 彩色小花 / 毛线款 / 蝴蝶结）
 * - 再匹配按总数兜底的规则（total = 图标总数，任意品类）
 * - 都没有时按模板的默认顺序依次放（若模板存在小花规则且含小花但未命中，仍进待核对）
 * - 顾客明确指定的位置优先；"名字后面"（name_after）在模板有 name_right 位置时直接落到 name_right，否则进待核对
 * - 位置冲突、超过位置数或规则勾选“需人工复核”时进入待核对，绝不自动增页
 */

export const ICON_KINDS: readonly IconKind[] = ['large', 'flower', 'yarn', 'bow'] as const;

export const ICON_KIND_LABELS: Record<IconKind, string> = {
  large: '普通图标',
  flower: '彩色小花',
  yarn: '毛线款',
  bow: '蝴蝶结',
};

export function normalizeIconKind(kind?: string | null): IconKind {
  if (kind === 'flower' || kind === 'yarn' || kind === 'bow') return kind;
  return 'large';
}

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

export function comboKey(icons: ParsedIcon[]): { total: number; large: number; flower: number; yarn: number; bow: number } {
  const counts = { total: icons.length, large: 0, flower: 0, yarn: 0, bow: 0 };
  for (const icon of icons) {
    counts[normalizeIconKind(icon.kind)]++;
  }
  return counts;
}

function formatRuleLabel(rule: LayoutRule): string {
  if (rule.total && rule.total > 0) return `共${rule.total}个图标`;
  const parts: string[] = [];
  if (rule.large) parts.push(`${rule.large}普通`);
  if (rule.flower) parts.push(`${rule.flower}小花`);
  if (rule.yarn) parts.push(`${rule.yarn}毛线`);
  if (rule.bow) parts.push(`${rule.bow}蝴蝶结`);
  return parts.join('+') || '0个';
}

function findSlotForCustomerPosition(slots: LayoutSlot[], pos: string): LayoutSlot | null {
  const byKey = slots.find((s) => s.key === pos);
  if (byKey) return byKey;
  if (pos === 'name_left' || pos === 'name_right' || pos === 'name_after') {
    const anchor = pos === 'name_left' ? 'name_left' : 'name_right';
    return slots.find((s) => s.anchor === anchor) || null;
  }
  const labelMap: Record<string, string> = { top_right: '右上', top_left: '左上', bottom_right: '右下', bottom_left: '左下' };
  const label = labelMap[pos];
  if (label) {
    const byLabel = slots.find((s) => (s.label || '').trim() === label);
    if (byLabel) return byLabel;
  }
  // 若位置是通过自由拖动新建的（key 为 slot_1 等），仅当对应象限内恰好只有一个自由位置时自动匹配
  const quadHits = slots.filter((s) => {
    if ((s.anchor || 'absolute') !== 'absolute') return false;
    const cx = (s.x ?? 0) + (s.w ?? 0) / 2;
    const cy = (s.y ?? 0) + (s.h ?? 0) / 2;
    if (pos === 'top_right') return cx >= 50 && cy < 50;
    if (pos === 'top_left') return cx < 50 && cy < 50;
    if (pos === 'bottom_right') return cx >= 50 && cy >= 50;
    if (pos === 'bottom_left') return cx < 50 && cy >= 50;
    return false;
  });
  return quadHits.length === 1 ? quadHits[0] : null;
}

export function assignIconSlots(icons: ParsedIcon[], template: LayoutTemplateLike): LayoutResult {
  const reasons: Reason[] = [];
  if (!icons.length) return { assignments: [], reasons, ruleLabel: null };
  const slotByKey = new Map(template.slots.map((s) => [s.key, s]));
  const counts = comboKey(icons);

  // 处理顾客指定位置（支持按 key、贴名字 anchor、中文备注或所在象限匹配）
  const resolvedPositions = new Map<ParsedIcon, string>();
  for (const icon of icons) {
    if (icon.position === 'name_after') {
      const hit = findSlotForCustomerPosition(template.slots, 'name_after');
      if (hit) {
        resolvedPositions.set(icon, hit.key);
      } else {
        reasons.push(review('position_name_after', `顾客要求图标放在"名字后面"（${icon.positionRaw || ''}），但模板"${template.name}"没有“贴名字右”位置，请人工核对`));
      }
    } else if (icon.position) {
      const hit = findSlotForCustomerPosition(template.slots, icon.position);
      if (!hit) {
        reasons.push(review('position_not_in_template', `顾客指定位置 ${icon.position}（${icon.positionRaw || ''}）不在布局模板"${template.name}"中`));
      } else {
        resolvedPositions.set(icon, hit.key);
      }
    }
  }
  if (reasons.length) return { assignments: [], reasons, ruleLabel: null };

  // 1. 组合规则：先精确匹配品类组合，再匹配按总数兜底的规则
  const exactRule = template.rules.find(
    (r) =>
      !(r.total && r.total > 0) &&
      (r.large || 0) === counts.large &&
      (r.flower || 0) === counts.flower &&
      (r.yarn || 0) === counts.yarn &&
      (r.bow || 0) === counts.bow,
  );
  const totalRule = !exactRule ? template.rules.find((r) => r.total && r.total === counts.total) : undefined;
  const rule = exactRule || totalRule;

  let plan: Array<{ slot: string; kind: PlacementKind }> = [];
  let ruleLabel: string | null = null;
  if (rule) {
    plan = rule.placements.map((p) => ({ slot: p.slot, kind: p.kind || 'any' }));
    ruleLabel = formatRuleLabel(rule);
    if (rule.requiresReview) {
      reasons.push(review('layout_complex', `组合 ${ruleLabel} 在模板中标记为需人工复核`));
    }
  } else if (template.rules.some((r) => !(r.total && r.total > 0) && (r.flower || 0) > 0) && counts.flower > 0) {
    const desc = formatRuleLabel({ large: counts.large, flower: counts.flower, yarn: counts.yarn, bow: counts.bow, placements: [] });
    reasons.push(review('layout_no_rule', `布局模板"${template.name}"没有 ${desc} 的组合规则`));
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
  for (const icon of icons) {
    const pos = resolvedPositions.get(icon);
    if (!pos) continue;
    if (used.has(pos)) {
      reasons.push(review('position_conflict', `两个图标都指定了位置 ${pos}`));
      continue;
    }
    used.add(pos);
    assignments.push({ icon, slot: slotByKey.get(pos)! });
  }
  // 3. 其余按规则顺序（优先匹配同品类槽位，其次 'any' 槽位）
  for (const icon of icons) {
    if (resolvedPositions.has(icon)) continue;
    const kind = normalizeIconKind(icon.kind);
    const next =
      plan.find((p) => !used.has(p.slot) && p.kind === kind) ||
      plan.find((p) => !used.has(p.slot) && p.kind === 'any');
    if (!next) {
      reasons.push(review('layout_over_capacity', `图标 ${icon.iconName} 没有可用的${ICON_KIND_LABELS[kind]}位置`));
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
    const label = formatRuleLabel(rule);
    for (const p of rule.placements || []) {
      if (!keys.has(p.slot)) errors.push(`组合 ${label} 引用了不存在的位置 ${p.slot}`);
    }
    if (rule.total && rule.total > 0) {
      if ((rule.placements || []).length !== rule.total) {
        errors.push(`按总数规则（${label}）的位置数量与总数不一致`);
      }
    } else {
      const counts: Record<IconKind, number> = { large: 0, flower: 0, yarn: 0, bow: 0 };
      for (const p of rule.placements || []) {
        const k = normalizeIconKind(p.kind);
        counts[k]++;
      }
      if (
        counts.large !== (rule.large || 0) ||
        counts.flower !== (rule.flower || 0) ||
        counts.yarn !== (rule.yarn || 0) ||
        counts.bow !== (rule.bow || 0)
      ) {
        errors.push(`组合 ${label} 的位置数量与各品类数量不一致`);
      }
    }
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
