'use client';

import { ArrowUUpLeftIcon } from '@phosphor-icons/react/ArrowUUpLeft';
import { BookmarkSimpleIcon } from '@phosphor-icons/react/BookmarkSimple';
import { ChatSlashIcon } from '@phosphor-icons/react/ChatSlash';
import { ChatsIcon } from '@phosphor-icons/react/Chats';
import { ClipboardTextIcon } from '@phosphor-icons/react/ClipboardText';
import { ConfettiIcon } from '@phosphor-icons/react/Confetti';
import { EnvelopeOpenIcon } from '@phosphor-icons/react/EnvelopeOpen';
import { FileMagnifyingGlassIcon } from '@phosphor-icons/react/FileMagnifyingGlass';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/PaperPlaneTilt';
import { XCircleIcon } from '@phosphor-icons/react/XCircle';
import {
  APPLICATION_STATUSES,
  STATUS_INFO,
  isDraftStatus,
  type ApplicationStatus,
  type DisplayStatus,
  type StatusIcon as StatusIconName,
} from '@tailorit/shared';
import type { SelectOption } from '@/components/ui/Select';
import type { Icon, IconProps } from '@/components/ui/icons';

/** The Phosphor glyph of each status (bookmark, paper plane, document search, chats, open envelope, …). */
const ICONS: Record<StatusIconName, Icon> = {
  bookmark: BookmarkSimpleIcon,
  'paper-plane': PaperPlaneTiltIcon,
  'file-search': FileMagnifyingGlassIcon,
  chats: ChatsIcon,
  'envelope-open': EnvelopeOpenIcon,
  undo: ArrowUUpLeftIcon,
  'chat-slash': ChatSlashIcon,
  'x-circle': XCircleIcon,
  confetti: ConfettiIcon,
};

export function StatusIcon({ status, ...props }: { status: ApplicationStatus } & IconProps) {
  const Glyph = ICONS[STATUS_INFO[status].icon];
  return <Glyph {...props} />;
}

/** v20 A30: a shown status's glyph: Draft's clipboard (its kit is prepared), else the stored status's. */
export function DisplayStatusIcon({ status, ...props }: { status: DisplayStatus } & IconProps) {
  if (isDraftStatus(status)) return <ClipboardTextIcon {...props} />;
  return <StatusIcon status={status} {...props} />;
}

/** Every status as a select option with its icon, in the statuses' order. */
export function statusOptions(): SelectOption<string>[] {
  return APPLICATION_STATUSES.map((status) => ({
    value: String(status),
    label: STATUS_INFO[status].label,
    textValue: STATUS_INFO[status].label,
    icon: <StatusIcon status={status} size={16} />,
  }));
}
