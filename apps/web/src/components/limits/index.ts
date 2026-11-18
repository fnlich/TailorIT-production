// v2.0: the shared limit pieces (docs/design/v2.0/08-ui.md, "Shared pieces"), used by the Auto-apply page, Settings ›
// Account, the Jobs AI search, Documents › Resumes and its batch download. Import from '@/components/limits'.
export { BuyCreditDialog, type BuyCreditDialogProps } from './BuyCreditDialog';
export { LIMIT_COPY, LIMIT_TITLES } from './copy';
export {
  LimitDialog,
  LockedFeatureDialog,
  useLimitDialog,
  type LimitDialogHandle,
  type LimitDialogProps,
  type LockedFeatureDialogProps,
} from './LimitDialog';
export { LimitActions, LimitNotice, type LimitNoticeProps } from './LimitNotice';
export {
  autoApplyLimit,
  buyCreditActionOf,
  limitButtons,
  limitFromError,
  limitTone,
  PAID_FEATURE_MESSAGES,
  paidFeatureLimit,
  resumeLimit,
  subscribeActionOf,
  toLimit,
  usageState,
  type LimitInfo,
  type LimitKind,
  type MessageRenderer,
  type PaidFeature,
  type PurchaseAction,
  type UsageState,
} from './limits';
export { PurchaseActionBody } from './PurchaseActionDialog';
export { SubscribeDialog, type SubscribeDialogProps } from './SubscribeDialog';
export { UsageMeter, UsageMeterSkeleton, type UsageMeterProps } from './UsageMeter';
