// v30 ST0: the admin tabs' base (PLAN §6, "Admin tabs"): AdminResourceTab (a whole tab's frame) on AdminTable, its
// loading rows and its heading row. Tabs are listed in features/settings/admin/registry.ts. ST5 owns this folder from
// v30-st0 on.
export { AdminResourceTab, type AdminEmpty, type AdminResourceTabProps, type AdminSectionProps } from './AdminResourceTab';
export { AdminTable, ScrollRegion, SectionHeader, TableSkeleton, type AdminColumn } from './AdminTable';
export { ShowMoreButton, type ShowMoreButtonProps } from './ShowMore'; // v30 FIX-WEB (UX-4)
