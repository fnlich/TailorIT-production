'use client';

import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { clsx } from 'clsx';
import { useState } from 'react';
import type { LetterTemplateSummary } from '@tailorit/shared/letters';
import { Badge } from '@/components/ui/Badge';
import { MENU_ROW, MENU_SURFACE, Z_FLOATING } from '@/components/ui/styles';
import { Tooltip } from '@/components/ui/Tooltip';
import { SHELL, SHELL_INPUT, ShellIndicator } from '../letter-editor/controlShell';
import { usePublicConstants } from '@/lib/constants';

/** "Base from template...": the other templates (starters included); choosing one asks the page to copy it in. */
export function BaseFromTemplateSelect({
  templates,
  onPick,
  disabled,
}: {
  templates: readonly LetterTemplateSummary[];
  onPick: (template: LetterTemplateSummary) => void;
  disabled?: boolean;
}) {
  const { t } = usePublicConstants();
  const [input, setInput] = useState('');
  const needle = input.trim().toLowerCase();
  const filtered = needle ? templates.filter((template) => template.name.toLowerCase().includes(needle)) : templates;

  return (
    <BaseCombobox.Root<LetterTemplateSummary>
      items={templates as LetterTemplateSummary[]}
      filteredItems={filtered}
      value={null}
      inputValue={input}
      onInputValueChange={setInput}
      itemToStringLabel={(template) => template.name}
      isItemEqualToValue={(a, b) => a.id === b.id}
      onValueChange={(template) => {
        if (!template) return;
        onPick(template);
        setInput('');
      }}
      disabled={disabled}
      autoHighlight
    >
      <Tooltip content="Replace editor content with a copy of another template">
        <div className={clsx(SHELL, 'w-full sm:w-[284px]')} data-base-from-template="">
          <BaseCombobox.Input
            aria-label={t('LABEL_LETTER_START_FROM_TEMPLATE').replace(/\.+$/, '')}
            placeholder={t('LABEL_LETTER_START_FROM_TEMPLATE')}
            className={SHELL_INPUT}
          />
          <BaseCombobox.Trigger aria-label="Show templates" className="flex h-full items-center rounded-r-control outline-offset-0">
            <ShellIndicator />
          </BaseCombobox.Trigger>
        </div>
      </Tooltip>
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner sideOffset={6} align="start" className={clsx(Z_FLOATING, 'outline-none')}>
          <BaseCombobox.Popup
            className={clsx(
              MENU_SURFACE,
              'max-h-[min(20rem,var(--available-height))] w-(--anchor-width) min-w-64 max-w-(--available-width) overflow-y-auto overscroll-contain',
            )}
          >
            <BaseCombobox.Empty className="px-1.5 py-2 text-sm text-muted-foreground empty:hidden">No templates match.</BaseCombobox.Empty>
            <BaseCombobox.List className="outline-none">
              {(template: LetterTemplateSummary) => (
                <BaseCombobox.Item key={template.id} value={template} className={MENU_ROW}>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex w-full items-center gap-2">
                      <span className="min-w-0 truncate font-medium">{template.name}</span>
                      {template.isSystem && (
                        <Badge tone="outline" className="ml-auto">
                          {t('LABEL_DOCS_TEMPLATE_BUILT_IN')}
                        </Badge>
                      )}
                    </span>
                    {template.preview && <span className="truncate text-xs leading-4 text-muted-foreground">{template.preview}</span>}
                  </span>
                </BaseCombobox.Item>
              )}
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
