'use client';

import { useState, type FormEvent } from 'react';
import {
  REPLACE_PLACEHOLDER_TITLE,
  replacePlaceholderHint,
  variableDefinition,
} from '@tailorit/shared/letters';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { HelpTip } from '@/components/ui/HelpTip';
import { WarningCircleIcon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/Input';
import { usePublicConstants } from '@/lib/constants';

/**
 * The "A few blanks left to fill" line over the paper (v31 FIX-DOCS: MSG_LETTER_BLANKS_TITLE / _TEXT): one chip per
 * `{{TAG}}` still in the letter; a chip opens "Replace placeholder", which replaces every copy of that tag. v32 COPY
 * (E4/E5): a compact row (a warning icon, the title, its sentence in a "?", the chips), never a coloured banner.
 */
export function PlaceholderBanner({ names, onPick }: { names: readonly string[]; onPick: (name: string) => void }) {
  const { t } = usePublicConstants();
  if (names.length === 0) return null;
  return (
    <section
      aria-label="Unfilled placeholders"
      data-placeholder-banner=""
      className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm leading-5"
    >
      <span className="flex items-center gap-1.5">
        <WarningCircleIcon size={18} weight="fill" className="shrink-0 text-warning" aria-hidden="true" />
        <p className="font-semibold text-foreground">{t('MSG_LETTER_BLANKS_TITLE')}</p>
        <HelpTip label={t('MSG_LETTER_BLANKS_TITLE')}>{t('MSG_LETTER_BLANKS_TEXT')}</HelpTip>
      </span>
      <div className="min-w-0">
        <ul className="flex flex-wrap gap-2">
          {names.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => onPick(name)}
                title={variableDefinition(name)?.description}
                className="rounded-tag bg-primary-soft px-1.5 py-px text-[13px] font-medium text-primary-ink ring-1 ring-primary-200 transition-colors hover:bg-primary-100 focus-visible:outline-offset-1"
              >
                {`{{${name}}}`}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function ReplacePlaceholderDialog({
  name,
  onOpenChange,
  onApply,
}: {
  name: string | null;
  onOpenChange: (open: boolean) => void;
  onApply: (name: string, text: string) => void;
}) {
  return (
    <Dialog open={name !== null} onOpenChange={onOpenChange}>
      {name !== null && <ReplaceForm key={name} name={name} onClose={() => onOpenChange(false)} onApply={onApply} />}
    </Dialog>
  );
}

function ReplaceForm({ name, onClose, onApply }: { name: string; onClose: () => void; onApply: (name: string, text: string) => void }) {
  const [text, setText] = useState('');
  const definition = variableDefinition(name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    onApply(name, text);
    onClose();
  };
  return (
    <DialogContent title={REPLACE_PLACEHOLDER_TITLE} help={replacePlaceholderHint(name)} size="md">
      <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
        <Field label={definition?.label ?? name} hint={definition?.description}>
          <Textarea
            value={text}
            autoFocus
            autoGrow
            rows={2}
            placeholder={`Text for {{${name}}}`}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </Field>
        <DialogFooter flush className="pt-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!text.trim()}>
            Apply
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
