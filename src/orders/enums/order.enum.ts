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