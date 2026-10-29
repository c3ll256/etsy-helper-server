import { FieldRole } from './types';

/**
 * Variations 标签词表。来源：2026-10-29 生产快照中约 8.7 万行母婴上传 Excel 的实际标签
 * （旧格式 `标签:值,标签:值` 直接统计冒号前的文字；新格式按行首最长前缀对照）。
 *
 * 只有"角色"标签（名字 / 图标 / 颜色 / 附件 / 个性化）会参与提取，其余标签原样保留为商品选项。
 * 新店铺出现新的标签写法时，在这里补充即可；未知标签不会被猜测含义。
 */
interface LabelDef {
  label: string;
  role: FieldRole;
}

const ROLE_LABELS: LabelDef[] = [
  // 个性化（自由文本，名字和图标混写）
  ...['Personalization', 'Personalisation', 'Personnalisation', 'Personalization (optional)', 'Personalisierung', 'Personalización', 'Personalizzazione', 'Customization', 'Custom Name']
    .map((label) => ({ label, role: 'personalization' as FieldRole })),
  // 名字
  ...['Name', 'Names', 'Pet Name', 'Baby Name', 'Child Name', "Child's Name", 'Name to Embroider', 'Name or initials', 'Name or initial', 'Name/Initials']
    .map((label) => ({ label, role: 'name' as FieldRole })),
  // 名字 + 图标
  ...['Enter Name & Icon', 'Name & Icon', 'Name and Icon', 'Name + Icon', 'Name & Design', 'Name and Design']
    .map((label) => ({ label, role: 'name_icon' as FieldRole })),
  // 图标
  ...['Icon', 'Icons', 'Icon Selection', 'Icon Choice', 'Design Number', 'Design Choice', 'Design Choices', 'Design', 'Symbol', 'Symbols', 'Symbolnummer']
    .map((label) => ({ label, role: 'icon' as FieldRole })),
  // 颜色（毛线 / 名字颜色）
  ...['Yarn Color', 'Yarn Colour', 'Yarn colour', 'Yarn Clolor', 'Yarn Color for Name', 'Yarn Shade Selection', 'Name Color', 'Name Colour', 'Embroidery Thread Color', 'Thread Color', 'Lettering Color', 'Letter Color']
    .map((label) => ({ label, role: 'color' as FieldRole })),
  // 附件（照片等）：只是附件说明，绝不当作件数
  ...['Pet photo', 'Pet Photo', 'Photo for Your Pet Portrait', 'Photo', 'Photos', 'Upload Photo', 'Upload your photo']
    .map((label) => ({ label, role: 'attachment' as FieldRole })),
];

/** 只作为商品选项保留的已知标签（用于新版格式切分标签和值） */
const OPTION_LABELS: string[] = [
  'Backpack Color | Add on', 'Backpack Color', 'Backpack Colour', 'Backpack Colours', 'Backpack Colour + Lunch Bag', 'Backpack Design', 'Backpack',
  'Backpack & Lunch Bag Color', 'Backpack & Lunch Bag Colour', 'Backtoschool Set',
  'Basket Size & Color & Add on', 'Basket Size & Color & Design', 'Basket Size&Color | Add on', 'Basket Size&Color', 'Basket Size & Color',
  'Basket Size (See image 3)', 'Basket Size (See image 4)', 'Basket Size (See image 5)', 'Basket Size (See image 6)', 'Basket Size',
  'Basket Color + Size', 'Basket Color & Size', 'Basket Color and Size', 'Basket Colour (See image 4)', 'Basket Colour | Add on', 'Basket Color', 'Basket Colour',
  'Basket Style and Size | Add on', 'Basket Style & Icon', 'Basket & Ears Color', 'Ears & Basket Color',
  'Bag Color & Design', 'Bag Colour & Set', 'Bag Colour & Size', 'Bag Color', 'Bag Colour', 'Bag Style', 'Bag Set Color', 'Choose Bag Color',
  'Lunch Bag Color', 'Lunch Bag', 'Lunchbag Color', 'Lunchbox Bag Color', 'Lunch Box Bag Style',
  'Crossbody Bag Color | Add on', 'Handbag Color | Add on', 'Handbag Color', 'Tote Bag Color', 'Makeup Bag Color', 'Pencil case Color | Add on',
  'Product Combination', 'Combo Option', 'Combo Optional', 'Choose Your Set', 'Choose Set Option', 'Select Your Set', 'Set Color', 'Set Option', 'Set Detail', 'Set', 'Gift Set',
  'Select ltems', 'Select Items', 'Items', 'Item', 'Option', 'Special Options', 'Customizable Options', 'What would you like to order?',
  'Stocking Color | Add on', 'Stocking Color ∣ Add on', 'Stocking Color', 'Stocking Design', 'Stocking Style',
  'Size & Style', 'Size & Desin', 'Size & Color', 'Size ∣ Add on', 'Size | Add on', 'Size', 'Sweater Color', 'Sweater Size', 'Hat Color', 'Hat Style', 'Beanie Color | Add on', 'Beanie',
  'Shape & Size', 'Portrait Style', 'Fabric Background', 'Halo Optional', 'Halo Option', 'Frame color & Portrait style', 'Choose Frame Shapes & Size',
  'Rattle Style', 'Rattle style', 'Rattle', 'Font Design', 'Font Style', 'Font Choice', 'Font', 'Choose Your Lettering Style', 'Choose Your Rattle Style',
  'Which Rattle Style Would You Like to Order?', 'Which Font Design Would You Like?', 'Which Style of Rattle Do You Like to Order?', 'Which Font Design Do You Like to Use?',
  'Ear Color', 'Bunny Color', 'Bunny Style', 'Lovey', 'Crown Style', 'Gift Box Style', 'Book Style', 'Animal', 'Style', 'Color (Backpack/Lunch Bag)', 'Color',
  'Blanket Color | Add on', 'Blanket Color | Design', 'Blanket Color', 'Cot Tidy Color | Add on', 'Banner Style', 'Number of Letters', 'Age & Size Design',
  'Hanger Size', 'Shipping Service', 'Service',
];

export interface LabelMatch {
  label: string;
  role: FieldRole;
  /** 原文中实际匹配的长度（含可选冒号） */
  length: number;
}

const ALL_LABELS: LabelDef[] = [
  ...ROLE_LABELS,
  ...OPTION_LABELS.map((label) => ({ label, role: 'option' as FieldRole })),
].sort((a, b) => b.label.length - a.label.length);

/** 编号式标签：1. Name / 2. Icon / 2.Design Choice / 1. Name Color */
const NUMBERED_LABEL = /^\s*\d\s*[.)]\s*(Name Colou?r|Name or initials?|Names?|Icons?|Design Choices?|Design|Symbol|Keychain)/i;

function roleOfNumbered(word: string): FieldRole {
  const w = word.toLowerCase();
  if (w.startsWith('name colo')) return 'color';
  if (w.startsWith('name')) return 'name';
  if (w.startsWith('keychain')) return 'option';
  return 'icon';
}

/**
 * 行首标签匹配（新版格式：标签与值紧连，大小写不敏感，允许标签后带冒号）。
 * 只认词表里的标签，不按大小写变化等规则猜测。
 */
export function matchLabelPrefix(line: string): LabelMatch | null {
  const numbered = line.match(NUMBERED_LABEL);
  if (numbered) {
    let length = numbered[0].length;
    const rest = line.slice(length);
    const colon = rest.match(/^\s*:\s*/);
    if (colon) length += colon[0].length;
    return { label: numbered[0].trim(), role: roleOfNumbered(numbered[1]), length };
  }
  const lower = line.toLowerCase();
  for (const def of ALL_LABELS) {
    if (lower.startsWith(def.label.toLowerCase())) {
      // 值可能以小写开头（真实样例：3. Iconpiggy、Designbone），所以不按大小写判断边界，只靠最长前缀
      let length = def.label.length;
      const rest = line.slice(length);
      const colon = rest.match(/^\s*:\s*/);
      if (colon) length += colon[0].length;
      return { label: def.label, role: def.role, length };
    }
  }
  return null;
}

/** 旧格式（逗号分隔）中冒号前的标签，返回角色；未知标签作为 option */
export function roleOfLabel(label: string): FieldRole {
  const trimmed = label.trim();
  const numbered = (trimmed + ':').match(NUMBERED_LABEL);
  if (numbered && numbered[0].trim().length >= trimmed.length - 1) return roleOfNumbered(numbered[1]);
  const lower = trimmed.toLowerCase();
  const exact = ALL_LABELS.find((d) => d.label.toLowerCase() === lower);
  if (exact) return exact.role;
  return 'option';
}

export function isKnownLabel(label: string): boolean {
  const lower = label.trim().toLowerCase();
  return ALL_LABELS.some((d) => d.label.toLowerCase() === lower) || NUMBERED_LABEL.test(label.trim() + ':');
}
