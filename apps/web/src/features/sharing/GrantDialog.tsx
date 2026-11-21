'use client';

import {
  SHARE_DEFAULT_PRESET,
  SHARE_PRESETS,
  SHARE_PRESET_LABELS,
  isGrantEnded,
  normalizePermissions,
  presetOf,
  type GrantPatchBodyInput,
  type GrantView,
  type SharePermission,
  type SharePreset,
} from '@tailorit/shared/sharing';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Button } from '../../components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { HelpTip } from '../../components/ui/HelpTip';
import { Input } from '../../components/ui/Input';
import { Notice } from '../../components/ui/Notice';
import { RadioGroup } from '../../components/ui/RadioGroup';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/Toast';
import { ApiError, userMessage } from '../../lib/api';
import { usePublicConstants } from '../../lib/constants';
import { changeGrant, createGrant, fetchGrants, invalidateSharing, sharingKeys } from './api';
import { GRANT_COPY } from './copy';
import { presetBoxes } from './grid';
import { PermissionGrid } from './PermissionGrid';

// v33 SHARE-7 (PLAN F9 "Grants", "Permissions"; SP v33 PLAN-sharing.md §2, §3, §9 "Settings › Sharing"): the share
// dialog. A new share: their email, the access (See only, See and prepare (the default), Custom), the grid, an optional
// end date. A change: the same without the email (PATCH: effective on their next request). "Send again" after a share
// ended opens it as a new share with that email and those boxes. The tip: "They sign in with this email and pay for any
// TailorIT AI they use." The 202 of an invite says the same whether or not the address has an account.
// v33 SHARE-7 (review finding: a stale tab re-granting): Change reads the share again as it opens and sends only what the
// person changed there (the boxes, or the end date), so a box taken away elsewhere is not given back by an end date.

/** What the dialog is for: a new share (maybe again, from an ended one), or a change of one. */
export type GrantDialogMode =
  | { kind: 'create'; email?: string; permissions?: readonly SharePermission[] }
  | { kind: 'change'; grant: GrantView; name: string };

export interface GrantDialogProps {
  /** Null: closed. */
  mode: GrantDialogMode | null;
  onOpenChange: (open: boolean) => void;
}

export function GrantDialog({ mode, onOpenChange }: GrantDialogProps) {
  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      {mode && (
        <DialogContent
          title={mode.kind === 'create' ? GRANT_COPY.createTitle : GRANT_COPY.changeTitle(mode.name)}
          description={mode.kind === 'change' ? mode.grant.email : undefined}
          help={GRANT_COPY.help}
          size="lg"
        >
          {/* A new form per opening: nothing typed before stays. */}
          {mode.kind === 'change' ? (
            <ChangeGrant key={mode.grant.key} grant={mode.grant} name={mode.name} onDone={() => onOpenChange(false)} />
          ) : (
            <GrantForm key={`new:${mode.email ?? ''}`} mode={mode} onDone={() => onOpenChange(false)} />
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

/** The local day of an ISO time as the date field's value ("2026-12-31"). */
export function dateFieldOf(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The date field's day as the share's end: the end of that local day; null for none (or a value that is no date). */
export function accessEndOf(field: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(field);
  if (!match) return null;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Whether an email is worth sending (the server checks it fully). */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export interface FormErrors {
  email?: string;
  endDate?: string;
  boxes?: string;
}

/** What the form says before anything is sent: a new share's email, an end date today or later, at least one box. */
export function checkGrantForm(form: {
  kind: GrantDialogMode['kind'];
  email: string;
  boxes: readonly SharePermission[];
  endDate: string;
  /** The local day today, as the date field writes it. */
  today: string;
}): FormErrors {
  const found: FormErrors = {};
  if (form.kind === 'create') {
    if (!form.email.trim()) found.email = GRANT_COPY.emailMissing;
    else if (!looksLikeEmail(form.email)) found.email = GRANT_COPY.emailInvalid;
  }
  // The share ends at the end of that day, so today is the soonest.
  if (form.endDate && (!accessEndOf(form.endDate) || form.endDate < form.today)) found.endDate = GRANT_COPY.endPast;
  if (form.boxes.length === 0) found.boxes = GRANT_COPY.nothingTicked;
  return found;
}

/** A refused save: the fields it names go under them; anything else is one message under the form. */
export function grantErrorsOf(error: unknown): { errors: FormErrors; formError: string | null } {
  const fields = error instanceof ApiError ? error.fields : undefined;
  const errors: FormErrors = {};
  if (fields?.email) errors.email = String(fields.email);
  if (fields?.accessEndsAt) errors.endDate = String(fields.accessEndsAt);
  if (fields?.permissions) errors.boxes = String(fields.permissions);
  return { errors, formError: Object.keys(errors).length > 0 ? null : userMessage(error, GRANT_COPY.saveFailed) };
}

/**
 * v33 SHARE-7: a Change's PATCH: only what differs from the share as the dialog read it (null: nothing changed). An end
 * date left alone is not sent again (re-derived from another time zone's day it would move); boxes left alone are not
 * sent (another tab's change stands).
 */
export function grantChangesOf(
  grant: Pick<GrantView, 'permissions' | 'accessEndsAt'>,
  boxes: readonly SharePermission[],
  endDate: string,
): GrantPatchBodyInput | null {
  const body: GrantPatchBodyInput = {};
  if (normalizePermissions(boxes).join(' ') !== normalizePermissions(grant.permissions).join(' ')) body.permissions = [...boxes];
  if (endDate !== dateFieldOf(grant.accessEndsAt)) body.accessEndsAt = accessEndOf(endDate);
  return body.permissions === undefined && body.accessEndsAt === undefined ? null : body;
}

/** The share as the server has it now (read when Change opens); null while reading. */
type FreshGrant = { kind: 'read'; grant: GrantView } | { kind: 'ended' } | { kind: 'failed' } | null;

/** Change: the share read again first, then the form on it (on the listed one if that read fails). */
function ChangeGrant({ grant, name, onDone }: { grant: GrantView; name: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [fresh, setFresh] = useState<FreshGrant>(null);
  useEffect(() => {
    let live = true;
    queryClient
      .fetchQuery({ queryKey: sharingKeys.grants, queryFn: ({ signal }) => fetchGrants(signal), staleTime: 0 })
      .then(
        (data) => {
          if (!live) return;
          const now = data.grants.find((one) => one.key === grant.key);
          setFresh(now && !isGrantEnded(now.state) ? { kind: 'read', grant: now } : { kind: 'ended' });
        },
        () => {
          if (live) setFresh({ kind: 'failed' });
        },
      );
    return () => {
      live = false;
    };
  }, [grant.key, queryClient]);

  if (fresh === null) {
    return (
      <div className="mt-5 flex justify-center py-10" data-grant-reading="">
        <Spinner size={20} label={GRANT_COPY.reading} />
      </div>
    );
  }
  if (fresh.kind === 'ended') {
    return (
      <div className="mt-5 flex flex-col" data-grant-ended="">
        <Notice tone="info">{GRANT_COPY.endedMeanwhile}</Notice>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            {GRANT_COPY.close}
          </Button>
        </DialogFooter>
      </div>
    );
  }
  const current = fresh.kind === 'read' ? fresh.grant : grant;
  return <GrantForm mode={{ kind: 'change', grant: current, name }} onDone={onDone} />;
}

function GrantForm({ mode, onDone }: { mode: GrantDialogMode; onDone: () => void }) {
  const { t } = usePublicConstants();
  const toast = useToast();
  const queryClient = useQueryClient();
  const gridLabelId = useId();
  const [email, setEmail] = useState(mode.kind === 'create' ? (mode.email ?? '') : mode.grant.email);
  const [boxes, setBoxes] = useState<SharePermission[]>(() =>
    mode.kind === 'change'
      ? [...mode.grant.permissions]
      : mode.permissions
        ? [...mode.permissions]
        : presetBoxes(SHARE_DEFAULT_PRESET, []),
  );
  // Custom stays chosen even while its boxes match a preset, until another preset is chosen.
  const [customChosen, setCustomChosen] = useState(false);
  const [endDate, setEndDate] = useState(mode.kind === 'change' ? dateFieldOf(mode.grant.accessEndsAt) : '');
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const preset: SharePreset = customChosen ? 'custom' : presetOf(boxes);
  const today = dateFieldOf(new Date().toISOString());

  const save = useMutation({
    mutationFn: async (changes: GrantPatchBodyInput | null) => {
      if (mode.kind === 'create') {
        const created = await createGrant({ email: email.trim(), permissions: boxes, accessEndsAt: accessEndOf(endDate) });
        return created.message;
      }
      // v33 SHARE-7: only what changed (submit checked there is something).
      if (changes) await changeGrant(mode.grant.key, changes);
      return null;
    },
    onSuccess: (message) => {
      void invalidateSharing(queryClient);
      if (message) toast.success(message);
      else toast.success(GRANT_COPY.changed);
      onDone();
    },
    onError: (error) => {
      const refused = grantErrorsOf(error);
      setErrors((current) => ({ ...current, ...refused.errors }));
      setFormError(refused.formError);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const found = checkGrantForm({ kind: mode.kind, email, boxes, endDate, today });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (mode.kind === 'change') {
      const changes = grantChangesOf(mode.grant, boxes, endDate);
      // Nothing changed: nothing to send.
      if (!changes) {
        onDone();
        return;
      }
      save.mutate(changes);
      return;
    }
    save.mutate(null);
  };

  return (
    <form onSubmit={submit} noValidate className="mt-5 flex min-h-0 flex-col" data-grant-form={mode.kind}>
      {/* The fields scroll inside the dialog on a short window; the buttons stay. */}
      <div className="-mx-6 flex min-h-0 flex-col gap-5 overflow-y-auto px-6 pb-1">
        {mode.kind === 'create' && (
          <Field label={GRANT_COPY.email} error={errors.email}>
            <Input
              type="email"
              inputMode="email"
              autoComplete="off"
              placeholder={GRANT_COPY.emailPlaceholder}
              value={email}
              maxLength={254}
              onChange={(event) => {
                setEmail(event.target.value);
                if (errors.email) setErrors((current) => ({ ...current, email: undefined }));
              }}
            />
          </Field>
        )}
        <Field label={GRANT_COPY.preset}>
          <RadioGroup
            name="share-preset"
            orientation="horizontal"
            value={preset}
            disabled={save.isPending}
            onValueChange={(next) => {
              setCustomChosen(next === 'custom');
              setBoxes((current) => presetBoxes(next, current));
              if (errors.boxes) setErrors((current) => ({ ...current, boxes: undefined }));
            }}
            options={SHARE_PRESETS.map((value) => ({ value, label: t(SHARE_PRESET_LABELS[value]) }))}
          />
        </Field>
        <div className="flex flex-col gap-1" data-grant-grid="">
          <span className="flex items-center gap-1.5">
            <span id={gridLabelId} className="text-sm leading-5 font-medium text-foreground">
              {GRANT_COPY.grid}
            </span>
            <HelpTip label={GRANT_COPY.grid}>{GRANT_COPY.gridTip}</HelpTip>
          </span>
          <PermissionGrid
            value={boxes}
            disabled={save.isPending}
            onChange={(next) => {
              setBoxes(next);
              setCustomChosen(presetOf(next) === 'custom');
              if (errors.boxes) setErrors((current) => ({ ...current, boxes: undefined }));
            }}
          />
          {errors.boxes && (
            <p className="text-[13px] leading-5 text-danger-ink" role="alert" data-field-error="">
              {errors.boxes}
            </p>
          )}
        </div>
        <Field label={GRANT_COPY.endDate} optional hint={GRANT_COPY.noEndTip} error={errors.endDate}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={endDate}
              min={today}
              wrapperClassName="w-44"
              onChange={(event) => {
                setEndDate(event.target.value);
                if (errors.endDate) setErrors((current) => ({ ...current, endDate: undefined }));
              }}
            />
            {endDate && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setEndDate('')}>
                {GRANT_COPY.clearEnd}
              </Button>
            )}
          </div>
        </Field>
        {formError && (
          <Notice tone="error" data-grant-error="">
            {formError}
          </Notice>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          {GRANT_COPY.cancel}
        </Button>
        <Button type="submit" loading={save.isPending}>
          {save.isPending
            ? mode.kind === 'create'
              ? GRANT_COPY.busyCreate
              : GRANT_COPY.busyChange
            : mode.kind === 'create'
              ? GRANT_COPY.submitCreate
              : GRANT_COPY.submitChange}
        </Button>
      </DialogFooter>
    </form>
  );
}
