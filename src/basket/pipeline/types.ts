/**
 * 母婴 v2 流水线的共享类型。
 * pipeline/ 下的模块都是纯函数，不依赖数据库和 Nest，回归脚本可以直接调用。
 */

export type MatchStatus = 'exact' | 'prefix' | 'unmatched' | 'conflict' | 'none';
export type ProduceMode = 'ppt' | 'external' | 'ignore';

export interface NameArea {
  /** 相对实际幻灯片的百分比，左上角为 0，右下角为 100 */
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export interface NameLayoutConfig {
  area?: NameArea | null;
  maxFontSize?: number | null;
  minFontSize?: number | null;
  preferredFontSize?: number | null;
  allowTwoLines?: boolean | null;
  /** 超过多少个拉丁字母进入待核对；空表示不限 */
  maxLatinLetters?: number | null;
  /** 区域内缩（pt），用于"预留缓冲" */
  bufferPt?: number | null;
  /** 双行时在页面上提示的文字（例如"名字做在同一行"），空表示不提示 */
  twoLineNote?: string | null;
  /** 来源说明，例如 appendix:lunch_bag */
  presetKey?: string | null;
  /** 区域是否已由甲方确认；false 时页面显示"区域未确认" */
  confirmed?: boolean | null;
}

export interface ComboOverride {
  fontSize?: number;
  colorGroupId?: number;
  iconGroupId?: number;
  iconLayoutTemplateId?: number;
  maxIcons?: number;
  nameLayout?: NameLayoutConfig;
}

export interface SkuConfigLike {
  id: number;
  userId?: string;
  sku: string;
  type: string;
  replaceValue?: string | null;
  fontSize?: number | null;
  font?: string | null;
  yarnColorMap?: Record<string, string> | null;
  comboItems?: string[] | null;
  colorGroupId?: number | null;
  iconGroupId?: number | null;
  comboOverridesJson?: Record<string, ComboOverride> | null;
  externalOrderReminderEnabled?: boolean | null;
  externalOrderReminderContent?: string | null;
  produceMode?: ProduceMode | null;
  iconLayoutTemplateId?: number | null;
  maxIcons?: number | null;
  requireReviewOnIcons?: boolean | null;
  nameLayout?: NameLayoutConfig | null;
}

export type IconKind = 'large' | 'flower' | 'yarn' | 'bow';
export type PlacementKind = IconKind | 'any';

export interface IconEntry {
  id: number;
  name: string;
  code?: string | null;
  aliases?: string[] | null;
  kind?: IconKind | string | null;
  filePath: string;
  /** 素材文件是否存在（由调用方检查磁盘后填入） */
  fileExists: boolean;
}

export interface ColorEntry {
  name: string;
  colorValue: string;
  colorSequence?: string[] | null;
}

export interface LayoutSlot {
  key: string;
  label?: string;
  /** absolute：按幻灯片百分比；name_left / name_right：贴在名字左右 */
  anchor?: 'absolute' | 'name_left' | 'name_right';
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** 贴名字时图标边长（占幻灯片高度的百分比） */
  size?: number;
}

export interface LayoutRule {
  /** 按总数匹配（任意品类）；>0 时按总数匹配，优先级低于精确品类规则 */
  total?: number;
  /** 适用组合：普通大图标数、彩色小花数、毛线款数、蝴蝶结数 */
  large: number;
  flower: number;
  yarn?: number;
  bow?: number;
  /** 依次放置：每一枚图标的位置 */
  placements: Array<{ slot: string; kind: PlacementKind }>;
  /** 复杂组合：需人工复核 */
  requiresReview?: boolean;
}

export interface LayoutTemplateLike {
  id: number;
  name: string;
  slots: LayoutSlot[];
  rules: LayoutRule[];
  /** 没有命中规则时，按顺序依次放置（单个优先第一个位置） */
  defaultOrder: string[];
}

export interface FontEntry {
  id: number;
  name: string;
  filePath: string;
  fileExists: boolean;
}

export interface ShopSettings {
  /** 名字含特殊字符时，在大字上方用红色原样标注 */
  specialCharAnnotationEnabled: boolean;
  /** 标注字号（pt）。需求写"40号"，单位待确认，默认按 40pt */
  specialCharAnnotationFontSize: number;
  specialCharAnnotationFont: string;
  /** 重音字符和 & 使用的字体 */
  specialCharFont: string;
  /** & 比基准字号小多少 pt */
  ampersandSizeDelta: number;
  /** 重音字符和 & 切换字体的时机：always 总是；missing_glyph 仅主字体缺字时 */
  specialCharFontMode: 'always' | 'missing_glyph';
  /** 未生成的待核对行是否生成"待核对占位页"（不计入页码，不可制作） */
  reviewPlaceholderPages: boolean;
  /** 没有图标布局模板时用系统默认排列；关闭则进入待核对 */
  allowDefaultIconLayout: boolean;
}

export const DEFAULT_SHOP_SETTINGS: ShopSettings = {
  specialCharAnnotationEnabled: true,
  specialCharAnnotationFontSize: 40,
  specialCharAnnotationFont: 'Calibri',
  specialCharFont: 'Calibri',
  ampersandSizeDelta: 10,
  specialCharFontMode: 'missing_glyph',
  reviewPlaceholderPages: true,
  allowDefaultIconLayout: true,
};

export type ReasonSeverity = 'blocking' | 'warning';

export interface Reason {
  code: string;
  message: string;
  severity: ReasonSeverity;
  /** 系统异常（配置 / 字体 / 素材），区别于顾客内容问题 */
  system?: boolean;
}

export interface RawRow {
  rowIndex: number;
  /** 表头已 trim 的原始单元格（字符串化） */
  cells: Record<string, string>;
}

export interface ParsedField {
  label: string | null;
  value: string;
  role: FieldRole;
}

export type FieldRole =
  | 'personalization'
  | 'name'
  | 'icon'
  | 'name_icon'
  | 'color'
  | 'attachment'
  | 'option';

export interface ParsedIcon {
  /** 顾客原文片段 */
  raw: string;
  /** 匹配到的图标（完整编号 / 名称） */
  iconId?: number;
  iconName?: string;
  kind?: string;
  filePath?: string;
  fileExists?: boolean;
  /** 顾客指定的位置（模板位置 key），可空 */
  position?: string | null;
  positionRaw?: string | null;
  /** 混色名字 + 毛线款图标自动算出的毛线颜色 */
  yarnColor?: string | null;
  yarnColorNote?: string | null;
}

export interface ParsedItem {
  /** 该组成件 / 该件商品的名字；null 表示没有名字 */
  name: string | null;
  icons: ParsedIcon[];
  /** 套组中明确指定的组成件（comboItems 中的值） */
  component?: string | null;
}

export interface ParseResult {
  format: 'newline' | 'comma' | 'single' | 'empty';
  fields: ParsedField[];
  /** 解析出的定制项：普通商品每项对应一件；套组为公共项或指定组成件 */
  items: ParsedItem[];
  colorRaw: string | null;
  colorLabel: string | null;
  attachments: string[];
  notes: string[];
  reasons: Reason[];
  source: 'rule' | 'llm' | 'manual';
}

export interface ProductionUnit {
  unitKey: string;
  /** 第几件（1..quantity） */
  itemIndex: number;
  component: string | null;
  name: string | null;
  icons: ParsedIcon[];
  colorRaw: string | null;
  colorMapped: string | null;
  yarnColorSummary?: string | null;
  iconGroupId: number | null;
  layoutTemplateId: number | null;
  nameLayout: NameLayoutConfig | null;
  fontSize: number | null;
  font: string | null;
  status: 'ok' | 'review';
  reasons: Reason[];
  /** 生成后回填 */
  groupPosition?: string;
  slideNumber?: number;
  render?: Record<string, any>;
}

export type LineStatus =
  | 'produced'
  | 'review'
  | 'failed'
  | 'unmatched'
  | 'conflict'
  | 'duplicate'
  | 'external'
  | 'ignored'
  | 'out_of_scope'
  | 'pending';

export interface LineDraft {
  rowIndex: number;
  orderId: string;
  transactionId: string | null;
  sku: string;
  itemName: string | null;
  quantity: number;
  quantityRaw: string;
  variationsRaw: string;
  noteRaw: string | null;
  shipName: string | null;
  orderDate: string | null;
  datePaid: string | null;
  shipState: string | null;
  shipAddress: string | null;
  rawRow: Record<string, string>;
  dedupeKey: string;
  duplicateOfRowIndex: number | null;

  matchStatus: MatchStatus;
  skuConfigId: number | null;
  matchedSku: string | null;
  matchNote: string | null;
  produceMode: ProduceMode | null;

  parse: ParseResult | null;
  manualOverride?: ManualOverride | null;
  units: ProductionUnit[];
  status: LineStatus;
  exceptionCategory: string | null;
  reasons: Reason[];
  warnings: Reason[];
  expectedUnits: number;
  producedUnits: number;
  producedSlides: number[];
  reminderText: string | null;
  orderHasPages: boolean;
}

export interface ManualOverride {
  /** 每件 / 每个组成件的名字和图标（图标为完整编号或名称），人工指定 */
  units: Array<{ itemIndex?: number; component?: string | null; name: string | null; icons?: string[]; positions?: Array<string | null> }>;
  note?: string;
}
