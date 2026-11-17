'use client';

import { ArrowsDownUpIcon } from '@phosphor-icons/react/ArrowsDownUp';
import type { SectionOptions } from '@tailorit/shared/resume';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { GearSixIcon, PlusIcon, TrashIcon } from '@/components/ui/icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { Tooltip } from '@/components/ui/Tooltip';
import { Toolbar } from '@base-ui/react/toolbar';
import { PanelGroup, ToolIcon, ToolPopover, ToolSeparator, ToolText, ToolbarShell, type CHIP_REFUSALS } from './parts';
import { ChipAddForm } from './skillLibrary';
import type { SectionSetting, SectionTools } from './tools';
import type { ToolbarCommands } from './useToolbarCommands';

// The bar above a selected section's title: + Entry (Skills: + Skill and + Group; Soft skills and Interests: + Skill or
// + Interest), Delete section (the content is kept, Undo in a toast), Rearrange... and Settings (capitals for every
// section title, and the section's own: the skills layout, group names, tag style, bullet markers, the languages'
// label and dots).

export interface SectionToolbarProps {
  tools: SectionTools;
  commands: ToolbarCommands;
  /** Where "+ Skill" puts a skill: the group the person was in, else the skills in no group. */
  skillList: string;
  onRearrange?: () => void;
  onEscape(): void;
}

export function SectionToolbar({ tools, commands, skillList, onRearrange, onEscape }: SectionToolbarProps) {
  const [open, setOpen] = useState<'settings' | 'chip' | null>(null);
  const toggle = (panel: 'settings' | 'chip') => (next: boolean) => setOpen(next ? panel : null);
  const name = tools.name;
  const chipTarget = tools.adds.includes('skill') ? skillList : tools.chipList;
  const list = tools.list;
  return (
    <ToolbarShell label={`Tools for the ${name} section`} onEscape={onEscape}>
      {tools.adds.includes('entry') && list ? (
        <ToolText
          label={`Add an entry to ${name}`}
          tooltip="Add an entry at the end"
          icon={<PlusIcon size={14} weight="bold" />}
          // A section with no entries shows an empty row already: the caret goes into it.
          onClick={() => (tools.lastId ? commands.addEntry(list, tools.lastId) : commands.focus({ kind: 'entry', path: `${list}.new` }))}
        >
          Entry
        </ToolText>
      ) : null}
      {chipTarget ? (
        <AddChipButton
          noun={tools.chipNoun}
          suggest={tools.adds.includes('skill')}
          section={name}
          open={open === 'chip'}
          onOpenChange={toggle('chip')}
          onAdd={(text) => commands.addChip(chipTarget, text)}
        />
      ) : null}
      {tools.adds.includes('group') ? (
        <ToolText label="Add a skill group" tooltip="Add a group of skills" icon={<PlusIcon size={14} weight="bold" />} onClick={commands.addGroup}>
          Group
        </ToolText>
      ) : null}
      {tools.adds.length > 0 ? <ToolSeparator /> : null}
      <ToolIcon
        label="Rearrange sections"
        tooltip="Rearrange..."
        icon={<ArrowsDownUpIcon size={16} />}
        onClick={() => onRearrange?.()}
      />
      <ToolPopover
        label={`Settings for the ${name} section`}
        tooltip="Settings"
        icon={<GearSixIcon size={16} />}
        title={`Settings for the ${name} section`}
        open={open === 'settings'}
        onOpenChange={toggle('settings')}
        width="w-64"
      >
        <SectionSettings tools={tools} commands={commands} />
      </ToolPopover>
      <ToolSeparator />
      <ToolIcon
        label={`Delete the ${name} section`}
        tooltip="Delete section"
        icon={<TrashIcon size={16} />}
        onClick={() => commands.removeSection(tools.ref)}
      />
    </ToolbarShell>
  );
}

function SectionSettings({ tools, commands }: { tools: SectionTools; commands: ToolbarCommands }) {
  return (
    <div className="flex flex-col gap-3 py-1">
      <PanelGroup label="Every section">
        <Checkbox
          label="Uppercase titles"
          checked={tools.uppercaseTitles}
          onCheckedChange={(on) => commands.setUppercaseTitles(on)}
        />
      </PanelGroup>
      {tools.settings.length > 0 ? (
        <PanelGroup label="This section" className="border-t border-border pt-3">
          {tools.settings.map((setting) => (
            <SettingControl key={setting.key} setting={setting} tools={tools} commands={commands} />
          ))}
        </PanelGroup>
      ) : null}
    </div>
  );
}

function SettingControl({
  setting,
  tools,
  commands,
}: {
  setting: SectionSetting;
  tools: SectionTools;
  commands: ToolbarCommands;
}) {
  if (setting.type === 'flag') {
    return (
      <Checkbox
        label={setting.label}
        checked={setting.value}
        onCheckedChange={(on) => {
          const patch: SectionOptions = {};
          patch[setting.key] = on;
          commands.setSectionOption(tools.ref, patch, `${setting.label.replace(/^Show /, '')} ${on ? 'shown' : 'hidden'}`);
        }}
      />
    );
  }
  if (setting.key === 'skillsLayout') {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] text-foreground">{setting.label}</p>
        <RadioGroup
          aria-label={setting.label}
          orientation="horizontal"
          options={setting.choices}
          value={setting.value}
          onValueChange={(value) => commands.setSectionOption(tools.ref, { skillsLayout: value }, `Skills as ${value}`)}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13px] text-foreground">{setting.label}</p>
      <RadioGroup
        aria-label={setting.label}
        orientation="horizontal"
        options={setting.choices}
        value={setting.value}
        onValueChange={(value) => commands.setSectionOption(tools.ref, { tagBorder: value }, `Tags with ${value === 'box' ? 'a box' : 'an underline'}`)}
      />
    </div>
  );
}


/** "+ Skill": a small box to type a skill (or an interest) into; it stays open to add several. */
function AddChipButton({
  noun,
  section,
  suggest,
  open,
  onOpenChange,
  onAdd,
}: {
  noun: string;
  section: string;
  /** Technical skills: the library's skills are offered. */
  suggest: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  onAdd(text: string): keyof typeof CHIP_REFUSALS | null;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip content={`Add a ${noun.toLowerCase()}`}>
        <Toolbar.Button
          aria-label={`Add a ${noun.toLowerCase()} to ${section}`}
          render={
            <PopoverTrigger
              render={
                <Button variant="ghost" size="sm" icon={<PlusIcon size={14} weight="bold" />} className="px-2">
                  {noun}
                </Button>
              }
            />
          }
        />
      </Tooltip>
      <PopoverContent aria-label={`Add a ${noun.toLowerCase()}`} side="bottom" align="start" padding="sm" className="w-72">
        <ChipAddForm
          label={noun}
          placeholder={noun === 'Interest' ? 'e.g. Chess' : 'e.g. TypeScript'}
          suggest={suggest}
          onAdd={onAdd}
        />
      </PopoverContent>
    </Popover>
  );
}
