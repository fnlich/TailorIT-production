import type { ToastApi } from '@/components/ui/Toast';
import { isProfileRefusal, userMessage } from '@/lib/api';

/**
 * v33 SHARE-9 (SPECS-W3, from SHARE-4: "skip your own toast for isProfileRefusal(error)"): says why something failed in a
 * toast, unless it is a shared profile's refusal (ended, not shared, own profile only), which the shell's alert already
 * says once. The Tracker's pages, its detail and the All profiles view say their failures through this.
 */
export function toastFailure(toast: Pick<ToastApi, 'error'>, error: unknown, fallback: string, title?: string): void {
  if (isProfileRefusal(error)) return;
  if (title === undefined) toast.error(userMessage(error, fallback));
  else toast.error(title, userMessage(error, fallback));
}
