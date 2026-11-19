'use client';

import { RESUME_TEMPLATE_IDS, RESUME_TEMPLATES, type ResumeTemplateId } from '@tailorit/shared/resume';
import { Field } from '@/components/ui/Field';
import { Select, type SelectOption } from '@/components/ui/Select';

const OPTIONS: SelectOption<ResumeTemplateId>[] = RESUME_TEMPLATE_IDS.map((id) => ({ value: id, label: RESUME_TEMPLATES[id].name }));

/**
 * The Upload dialog's "Template for the copy" (one file) or "Template for the copies" (several), under "Make an
 * editable copy with AI" while it is ticked: the editor's ten templates, by name. Each copy is a resume of the editor
 * on the template picked, and prints every section it has.
 */
export function CopyTemplateField({
  several,
  value,
  onChange,
  disabled,
}: {
  several: boolean;
  /** The template the copies start on. */
  value: ResumeTemplateId;
  onChange: (templateId: ResumeTemplateId) => void;
  disabled?: boolean;
}) {
  return (
    <Field
      label={several ? 'Template for the copies' : 'Template for the copy'}
      hint={several ? 'You can switch any of them later in the editor.' : 'You can switch it later in the editor.'}
    >
      <Select options={OPTIONS} value={value} onValueChange={onChange} disabled={disabled} />
    </Field>
  );
}
