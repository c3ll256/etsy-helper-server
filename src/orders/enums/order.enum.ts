export enum OrderStatus {
  STAMP_NOT_GENERATED = 'stamp_not_generated',
  STAMP_GENERATED_PENDING_REVIEW = 'stamp_generated_pending_review',
  STAMP_GENERATED_REVIEWED = 'stamp_generated_reviewed',
  STAMP_GENERATED_REVIEW_REJECTED = 'stamp_generated_review_rejected'
}

export enum OrderType {
  ETSY = 'etsy',
  MANUAL = 'manual',
  OTHER = 'other'
}

/**
 * 订单与模板的匹配状态
 * - exact：按规则唯一匹配
 * - unmatched：没有符合规则的模板
 * - conflict：多个模板同样符合（或摇铃多模板待选择）
 * - manual：操作员手动指定
 * - mismatch：历史订单当前模板与规则结果不一致，待复核
 * - legacy：历史订单只能靠旧的模糊匹配配上，规则下无模板
 */
export enum OrderMatchStatus {
  EXACT = 'exact',
  UNMATCHED = 'unmatched',
  CONFLICT = 'conflict',
  MANUAL = 'manual',
  MISMATCH = 'mismatch',
  LEGACY = 'legacy',
}

/** 未解决前不能制单、审核通过或导出的匹配状态 */
export const UNRESOLVED_MATCH_STATUSES: OrderMatchStatus[] = [
  OrderMatchStatus.UNMATCHED,
  OrderMatchStatus.CONFLICT,
  OrderMatchStatus.MISMATCH,
];
