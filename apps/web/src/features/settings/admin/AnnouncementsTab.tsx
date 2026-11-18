'use client';

import type { AdminAnnouncement, AdminAnnouncementList, Announcement } from '@tailorit/shared/announcements';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DatePickerPopover } from '@/components/ui/DatePickerPopover';
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { CalendarBlankIcon, PlusIcon } from '@/components/ui/icons';
import { Input, Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { AnnouncementList } from '../../announcements/AnnouncementBanner';
import {
  announcementKeys,
  createAnnouncement,
  deleteAnnouncement,
  fetchAdminAnnouncements,
  updateAnnouncement,
} from '../../announcements/api';
import {
  EMPTY_DRAFT,
  LIMITS,
  SEVERITY_BADGE,
  SEVERITY_OPTIONS,
  bodyOfDraft,
  draftOfAnnouncement,
  expiryText,
  type AnnouncementDraft,
  type DraftErrors,
} from './announcements';
import { HALF_HOURS } from './constants';
import { AdminResourceTab, type AdminColumn } from '@/components/admin';

// v2.0: Admin › Announcements (docs/design/v2.0/08-ui.md, "Announcements"; A19): the banner's messages. Saving one
// publishes it to every signed-in person at once, in plain text, until it expires, the admin deletes it, or each
// person dismisses it for themselves.

export function AnnouncementsTab() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: announcementKeys.admin, queryFn: ({ signal }) => fetchAdminAnnouncements(signal) });
  const [editing, setEditing] = useState<AdminAnnouncement | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminAnnouncement | null>(null);

  /** The admin's list and everyone's banner (this admin's too) are read again. */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: announcementKeys.admin });
    void queryClient.invalidateQueries({ queryKey: announcementKeys.active });
  };

  const columns: AdminColumn<AdminAnnouncement>[] = [
    {
      key: 'title',
      header: 'Announcement',
      cell: (item) => (
        <div className="min-w-0">
          <p className="truncate font-semibold">{item.title}</p>
          {item.body && <p className="line-clamp-2 text-[13px] whitespace-pre-line text-muted-foreground">{item.body}</p>}
        </div>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      className: 'w-28',
      cell: (item) => <Badge tone={SEVERITY_BADGE[item.severity]}>{SEVERITY_OPTIONS.find((option) => option.value === item.severity)?.label}</Badge>,
    },
    { key: 'expires', header: 'Expires', className: 'w-48 text-muted-foreground', cell: (item) => expiryText(item.expiresAt) },
    {
      key: 'status',
      header: 'Status',
      className: 'w-24',
      cell: (item) => (item.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Expired</Badge>),
    },
    { key: 'dismissed', header: 'Dismissed', className: 'w-24', numeric: true, cell: (item) => item.dismissedCount },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'w-40 text-right',
      cell: (item) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditing(item)} aria-label={`Edit ${item.title}`}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDeleting(item)} aria-label={`Delete ${item.title}`}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <AdminResourceTab
      title="Announcements"
      description="Messages every signed-in person sees in a banner under the header, the most severe first. Each person can dismiss one for themselves. Plain text only."
      actions={
        <Button icon={<PlusIcon size={16} weight="bold" />} onClick={() => setEditing('new')}>
          New announcement
        </Button>
      }
      items={list.data?.items}
      error={list.error}
      errorTitle="The announcements could not be loaded"
      empty={{
        title: 'No announcements',
        description: 'Make one to tell everyone about maintenance, a change or news.',
        variant: 'dashed',
        card: false,
      }}
      tableLabel="Announcements"
      columns={columns}
      getKey={(item) => item.id}
    >
      {editing && (
        <AnnouncementDialog
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            queryClient.setQueryData<AdminAnnouncementList>(announcementKeys.admin, (current) =>
              current
                ? { items: created ? [saved, ...current.items] : current.items.map((item) => (item.id === saved.id ? saved : item)) }
                : current,
            );
            refresh();
            setEditing(null);
            toast.success(created ? 'Announcement published' : 'Announcement saved');
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this announcement?"
        description={deleting ? `"${deleting.title}" leaves everyone's banner at once.` : undefined}
        confirmLabel="Delete"
        busyLabel="Deleting..."
        onConfirm={async () => {
          if (!deleting) return;
          await deleteAnnouncement(deleting.id);
          queryClient.setQueryData<AdminAnnouncementList>(announcementKeys.admin, (current) =>
            current ? { items: current.items.filter((item) => item.id !== deleting.id) } : current,
          );
          refresh();
          toast.success('Announcement deleted');
        }}
      />
    </AdminResourceTab>
  );
}

function AnnouncementDialog({
  item,
  onClose,
  onSaved,
}: {
  item: AdminAnnouncement | null;
  onClose: () => void;
  onSaved: (saved: AdminAnnouncement, created: boolean) => void;
}) {
  const now = useNow();
  const [draft, setDraft] = useState<AnnouncementDraft>(() => (item ? draftOfAnnouncement(item) : EMPTY_DRAFT));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof createAnnouncement>[0]) => (item ? updateAnnouncement(item.id, body) : createAnnouncement(body)),
    onSuccess: (saved) => onSaved(saved, item === null),
    onError: (error) => {
      if (error instanceof ApiError && error.fields) {
        setErrors({
          title: error.fields.title,
          body: error.fields.body,
          expires: error.fields.expiresAt,
        });
      }
      setFailure(userMessage(error));
    },
  });
  const set = <K extends keyof AnnouncementDraft>(key: K, value: AnnouncementDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors({});
    setFailure(null);
  };
  const preview: Announcement = {
    id: 'preview',
    title: draft.title.trim() || 'Your title',
    body: draft.body,
    severity: draft.severity,
    expiresAt: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={item ? 'Edit announcement' : 'New announcement'} size="xl">
        <form
          noValidate
          className="mt-5 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const result = bodyOfDraft(draft, Date.now());
            if (!result.ok) {
              setErrors(result.errors);
              return;
            }
            save.mutate(result.body);
          }}
        >
          <Field label="Title" required error={errors.title} hint={`${draft.title.length} / ${LIMITS.title}`}>
            <Input value={draft.title} maxLength={LIMITS.title} onChange={(event) => set('title', event.target.value)} />
          </Field>
          <Field label="Message" optional error={errors.body} hint={`Plain text; line breaks are kept. ${draft.body.length} / ${LIMITS.body}`}>
            <Textarea rows={5} value={draft.body} maxLength={LIMITS.body} onChange={(event) => set('body', event.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Severity">
              <Select options={SEVERITY_OPTIONS} value={draft.severity} onValueChange={(severity) => set('severity', severity)} />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm leading-5 font-medium text-foreground">Expires</span>
              <Checkbox checked={draft.noExpiry} onCheckedChange={(checked) => set('noExpiry', checked)} label="No expiry" />
              {!draft.noExpiry && (
                <div className="flex flex-wrap items-center gap-2">
                  <DatePickerPopover
                    value={draft.expiresOn}
                    minDate={new Date(now)}
                    aria-label="Expiry day"
                    onValueChange={(date) => set('expiresOn', date)}
                  >
                    <Button variant="outline" size="sm" icon={<CalendarBlankIcon size={16} />}>
                      {draft.expiresOn ? formatDate(draft.expiresOn) : 'Pick a day'}
                    </Button>
                  </DatePickerPopover>
                  <Select
                    aria-label="Expiry time"
                    size="sm"
                    options={HALF_HOURS}
                    value={draft.expiresAt}
                    onValueChange={(time) => set('expiresAt', time)}
                    className="w-32"
                  />
                </div>
              )}
              {errors.expires && <p className="text-[13px] leading-5 text-danger">{errors.expires}</p>}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-sm leading-5 font-medium text-foreground">Preview</p>
            <div className="overflow-hidden rounded-card border border-border" data-announcement-preview="">
              <AnnouncementList items={[preview]} alertIds={new Set()} onDismiss={() => {}} preview />
            </div>
          </div>
          {failure && <Notice tone="error">{failure}</Notice>}
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button type="submit" loading={save.isPending}>
              {item ? 'Save' : 'Publish'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
