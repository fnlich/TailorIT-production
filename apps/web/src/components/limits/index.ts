// v32 COPY: limits are alerts when the person acts (LimitDialog, useLimitDialog), a small chip with a "?" while a page
// is at one (LimitChip, LimitNotice), and today's AI use is a share only (AiUseMeter, aiUseOf).
// v2.0: the shared limit pieces (docs/design/v2.0/08-ui.md, "Shared pieces"), used by the Auto-apply page, Settings ›
// Account, the Jobs AI search, Documents › Resumes and its batch download. Import from '@/components/limits'.
export { aiUsedUp, aiUseOf, aiUseTone, type AiUse, type AiUseInput, type AiUseTone } from './aiUse';
export { BuyCreditDialog, type BuyCreditDialogProps } from './BuyCreditDialog';
export { LIMIT_COPY, LIMIT_TITLES } from './copy';
export {
  limitAlert,
  limitAlertTone,
  LimitDialog,
  LockedFeatureDialog,
  useLimitDialog,
  type LimitDialogHandle,
  type LimitDialogProps,
  type LockedFeatureDialogProps,
} from './LimitDialog';
export { LimitActions, LimitChip, LimitNotice, type LimitNoticeProps } from './LimitNotice';
export {
  aiUsedUpLimit,
  autoApplyLimit,
  buyCreditActionOf,
  limitButtons,
  limitFromError,
  limitOfTaskError,
  limitTone,
  PAID_FEATURE_MESSAGES,
  paidFeatureLimit,
  purchaseReachable,
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
export { useAiDialogGate, useAiUsedUp } from './useAiGate'; // v32 FIX-UX (UXREQ-3)
export { AiUseMeter, UsageMeter, UsageMeterSkeleton, type AiUseMeterProps, type UsageMeterProps } from './UsageMeter';
