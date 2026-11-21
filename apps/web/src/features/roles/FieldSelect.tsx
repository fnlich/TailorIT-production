'use client';

import { ROLE_FAMILIES, asRoleFamilyId, roleFamilyLabel } from '@tailorit/shared/roles';
import { clsx } from 'clsx';
import { Field } from '@/components/ui/Field';
import { Select, type SelectOption } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { isProfileRefusal } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { tabCan, useTabProfile } from '../sharing/access';
import { useResumeField, useSetResumeField } from './hooks';

// v33 ROLES (F4): a resume's Field: "Detect automatically" (what TailorIT read from it) or one of the 26 families.
// Tailoring, the letters and the editor's words follow it; the default resume's is the person's field.
// v33 FIX-1: the detected field is the line under the select, always (in the option's label it was cut: "Detect
// automatically (Software & technol…"); on a profile shared without Documents' Change the select is read-only, and a
// refusal of the shared profile is the shell's one alert, not this field's error too.

const AUTO = 'auto';

/** The Field select of one resume. */
export function FieldSelect({ resumeId, className }: { resumeId: string; className?: string }) {
  const { t } = usePublicConstants();
  const field = useResumeField(resumeId);
  const save = useSetResumeField(resumeId);
  const canChange = tabCan(useTabProfile(), 'documents:edit');
  const current = field.data;

  if (field.isPending) {
    return (
      <div className={clsx('flex flex-col gap-1.5', className)} aria-busy="true">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-9 w-full max-w-xs" />
      </div>
    );
  }
  // No field to show (an API without it, a resume not found): no select.
  if (!current) return null;

  const detected = roleFamilyLabel(current.detected);
  const options: SelectOption<string>[] = [
    { value: AUTO, label: t('LABEL_RESUME_FIELD_DETECT') },
    ...ROLE_FAMILIES.map((family) => ({ value: family.id as string, label: family.label })),
  ];
  const value = save.isPending && save.variables !== undefined ? (save.variables ?? AUTO) : (current.chosen ?? AUTO);
  const error = save.isError && !isProfileRefusal(save.error) ? t('MSG_RESUME_FIELD_SAVE_FAILED') : undefined;

  return (
    <div className={clsx('flex flex-col gap-1', className)} data-resume-field={current.familyId}>
      <Field label={t('LABEL_RESUME_FIELD')} hint={t('MSG_RESUME_FIELD_TIP')} error={error}>
        <Select
          options={options}
          value={value}
          disabled={save.isPending || !canChange}
          className="w-full max-w-xs"
          onValueChange={(next) => save.mutate(next === AUTO ? null : asRoleFamilyId(next))}
        />
      </Field>
      <p className="text-[13px] leading-5 text-muted-foreground" data-resume-field-detected="">
        {t('MSG_RESUME_FIELD_DETECTED', { field: detected })}
      </p>
    </div>
  );
}
