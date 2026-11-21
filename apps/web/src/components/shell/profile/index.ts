// v33 SHARE-4 (PLAN F9; SP v33 PLAN-sharing.md §9): the shell's profile parts and the hooks other packages read the
// tab's profile through. SHARE-7 (Settings › Sharing, the Profiles page, permission-aware pages) and SHARE-9 (the
// Tracker's All profiles view) import from here; the request side is lib/profile.ts and lib/api.ts (`profile` per call).
export { PROFILE_COPY } from './copy';
export { ProfileChip, chipName } from './ProfileChip';
export { PROFILES_HREF, SHARING_SETTINGS_HREF, ProfilesMenuGroup, SheetProfiles, useInviteCount, useProfileSwitch } from './ProfilesMenu';
export { ProfileRuntime } from './ProfileRuntime';
export {
  NO_SHARED_PROFILES,
  SHARING_PROFILES_QUERY_KEY,
  fetchSharedProfiles,
  profileCan,
  profileInitials,
  profileName,
  useDocumentProfile,
  useProfile,
  ProfilePreview,
  useProfileEyebrow,
  useSharedProfiles,
  type ProfilePreviewData,
  type ProfileView,
  type SharedProfilesRead,
} from './useProfile';
