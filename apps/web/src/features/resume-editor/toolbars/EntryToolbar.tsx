'use client';

import { ArrowDownIcon } from '@phosphor-icons/react/ArrowDown';
import { ArrowUpIcon } from '@phosphor-icons/react/ArrowUp';
import {
  MAX_BULLETS_NOTE_LENGTH,
  bulletsBlocker,
  type BulletsTask,
  type ResumeDocument,
} from '@tailorit/shared/resume';
import { memo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { GearSixIcon, PlusIcon, SparkleIcon, TrashIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Spinner } from '@/components/ui/Spinner';
import { entryBulletsTask } from '../ai/bulletsRequest';
import type { BulletsAi } from '../ai/useBulletsAi';
import { AiButton, ChipList } from '../parts';
import { valueAt } from '../store/actions';
import { PanelGroup, ToolIcon, ToolPopover, ToolSeparator, ToolText, ToolbarShell } from './parts';
import { ChipAddForm } from './skillLibrary';
import type { EntryTools } from './tools';
import type { ToolbarCommands } from './useToolbarCommands';

// The bar above the selected entry: + Entry, Move up and down, Write with AI (Experience, Projects, Volunteering),
// Settings (the entry's field toggles, "Apply to all in this section", and a role's "Skills used") and Delete. The
// empty row of a section with no entries has + Entry only.

/** What Settings says when Backspace finds an empty field (Enhancv's words). */
export const HIDE_FIELDS_HINT = 'Click here to hide fields';

/** Write with AI's run as the toolbars hold it: one at a time, for the entry it was asked for. */
export type EntryBulletsAi = BulletsAi<{ path: string; task: BulletsTask }>;

export interface EntryToolbarProps {
  tools: EntryTools;
  /** The document now (read when Write with AI opens: the bar is not drawn again for every keystroke). */
  currentDocument(): ResumeDocument;
  commands: ToolbarCommands;
  ai: EntryBulletsAi;
  /** Asks Write with AI for this entry. */
  onAsk(task: BulletsTask, note: string): void;
  /** Counts Backspace in an empty field of the entry: each points at Settings. */
  settingsHint?: number;
  onEscape(): void;
}

/**
 * Drawn again only when what it shows changes: typing in a bullet changes the document but not the bar (its bullets
 * are read by Write with AI when it opens), and the handlers read the latest state themselves.
 */
export const EntryToolbar = memo(function EntryToolbar({
  tools,
  currentDocument,
  commands,
  ai,
  onAsk,
  settingsHint = 0,
  onEscape,
}: EntryToolbarProps) {
  const [open, setOpen] = useState<'ai' | 'settings' | null>(null);
  const toggle = (panel: 'ai' | 'settings') => (next: boolean) => setOpen(next ? panel : null);
  const name = tools.name;
  return (
    <ToolbarShell label={`Tools for ${name}`} onEscape={onEscape}>
      <ToolText
        label={tools.placeholder ? `Add a ${tools.noun} entry` : `Add an entry after ${name}`}
        tooltip="Add an entry below"
        icon={<PlusIcon size={14} weight="bold" />}
        onClick={() => commands.addEntry(tools.list, tools.id)}
      >
        Entry
      </ToolText>
      {tools.placeholder ? null : (
        <>
          <ToolSeparator />
          <ToolIcon
            label={`Move ${name} up`}
            tooltip="Move up"
            icon={<ArrowUpIcon size={16} />}
            disabled={!tools.canMoveUp}
            onClick={() => commands.moveEntry(tools, -1)}
          />
          <ToolIcon
            label={`Move ${name} down`}
            tooltip="Move down"
            icon={<ArrowDownIcon size={16} />}
            disabled={!tools.canMoveDown}
            onClick={() => commands.moveEntry(tools, 1)}
          />
        </>
      )}
      {tools.ai ? (
        <ToolPopover
          label={`Write bullets with AI for ${name}`}
          tooltip="Write with AI"
          icon={<SparkleIcon size={16} weight="fill" className="text-primary-ink" />}
          title="Write with AI"
          open={open === 'ai'}
          onOpenChange={toggle('ai')}
          width="w-80"
        >
          <WriteWithAiPanel tools={tools} document={currentDocument()} ai={ai} onAsk={onAsk} />
        </ToolPopover>
      ) : null}
      {tools.toggles.length > 0 ? (
        <ToolPopover
          label={`Settings for ${name}`}
          tooltip="Settings"
          icon={<GearSixIcon size={16} />}
          title={`Settings for ${name}`}
          open={open === 'settings'}
          onOpenChange={toggle('settings')}
          width={tools.roleSkills ? 'w-80' : 'w-64'}
          hint={{ count: settingsHint, text: HIDE_FIELDS_HINT }}
        >
          <EntrySettings tools={tools} commands={commands} />
        </ToolPopover>
      ) : null}
      {tools.canDelete ? (
        <>
          <ToolSeparator />
          <ToolIcon label={`Delete ${name}`} tooltip="Delete" icon={<TrashIcon size={16} />} onClick={() => commands.removeEntry(tools)} />
        </>
      ) : null}
    </ToolbarShell>
  );
}, sameEntryToolbar);

/** The bar's tools as it draws them: the bullets by count only (their text is Write with AI's, read when it opens). */
const toolsKey = (tools: EntryTools) => JSON.stringify({ ...tools, bullets: tools.bullets.length });

function sameEntryToolbar(before: EntryToolbarProps, after: EntryToolbarProps): boolean {
  const run = (props: EntryToolbarProps) => [props.ai.run, props.ai.answer, props.ai.running, props.ai.failure, props.ai.progress];
  const [a, b] = [run(before), run(after)];
  return (
    before.commands === after.commands &&
    (before.settingsHint ?? 0) === (after.settingsHint ?? 0) &&
    a.every((value, index) => value === b[index]) &&
    toolsKey(before.tools) === toolsKey(after.tools)
  );
}

function EntrySettings({ tools, commands }: { tools: EntryTools; commands: ToolbarCommands }) {
  return (
    <div className="flex flex-col gap-3 py-1">
      <PanelGroup label="Fields">
        {tools.toggles.map((toggle) => (
          <Checkbox
            key={toggle.key}
            label={toggle.label}
            checked={toggle.shown}
            onCheckedChange={(shown) => commands.setEntryField(tools, toggle.key, shown)}
          />
        ))}
      </PanelGroup>
      <div className="border-t border-border px-1 pt-3">
        <Button
          variant="outline"
          size="sm"
          fullWidth
          disabled={tools.count < 2}
          onClick={() => commands.applyFieldsToSection(tools)}
        >
          Apply to all in this section
        </Button>
      </div>
      {tools.roleSkills ? <RoleSkills tools={tools} skills={tools.roleSkills} commands={commands} /> : null}
    </div>
  );
}

/** A role's "Skills used": not printed; each skill added also joins Technical skills. */
function RoleSkills({ tools, skills, commands }: { tools: EntryTools; skills: readonly string[]; commands: ToolbarCommands }) {
  return (
    <div className="flex flex-col gap-2 border-t border-border px-1 pt-3" role="group" aria-label="Skills used">
      <p className="text-xs font-medium text-muted-foreground">Skills used</p>
      <p className="text-[13px] leading-5 text-muted-foreground">Not printed. Each skill also joins your Technical skills.</p>
      <ChipAddForm
        label="Add a skill used in this role"
        placeholder="e.g. Kubernetes"
        suggest
        onAdd={(text) => commands.addRoleSkill(tools, text)}
      />
      <ChipList
        label="Skills used in this role"
        items={skills}
        onRemove={(skill) => commands.removeRoleSkill(tools, skills.indexOf(skill))}
      />
    </div>
  );
}

/**
 * Write with AI for one entry: Write (no bullets yet) or Improve (the bullets it has), an optional note, then the
 * answer replaces the bullets as one undo step. A run keeps going when the popover closes; its answer still lands in
 * the entry it was asked for.
 */
function WriteWithAiPanel({
  tools,
  document,
  ai,
  onAsk,
}: {
  tools: EntryTools;
  document: ResumeDocument;
  ai: EntryBulletsAi;
  onAsk(task: BulletsTask, note: string): void;
}) {
  const suggested = entryBulletsTask(document, tools.path);
  const [task, setTask] = useState<BulletsTask>(suggested);
  const [note, setNote] = useState('');
  const mine = ai.run?.meta.path === tools.path ? ai : null;
  const busy = ai.running;
  const entry = valueAt(document, tools.path);
  const blocker = tools.ai && entry && typeof entry === 'object' ? bulletsBlocker(tools.ai, entry) : null;
  const chosen = suggested === 'write' ? 'write' : task;
  const ask = () => {
    if (busy || blocker) return;
    onAsk(chosen, note);
  };
  return (
    <div className="flex flex-col gap-3 p-1">
      <SegmentedControl
        aria-label="Write new bullets or improve the ones there"
        size="sm"
        value={chosen}
        onValueChange={setTask}
        items={[
          { value: 'write', label: 'Write' },
          { value: 'improve', label: 'Improve', disabled: suggested === 'write' },
        ]}
      />
      <p className="text-[13px] leading-5 text-muted-foreground">
        {chosen === 'improve'
          ? 'Rewrites the bullets of this entry, keeping what they say.'
          : 'Writes bullets for this entry from its title, dates and description.'}
      </p>
      <Input
        aria-label="A note for the AI (optional)"
        placeholder="Optional: what to bring out"
        maxLength={MAX_BULLETS_NOTE_LENGTH}
        value={note}
        disabled={busy}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          ask();
        }}
      />
      {blocker ? <p className="text-[13px] leading-5 text-muted-foreground">{blocker}</p> : null}
      <div>
        <AiButton onClick={ask} disabled={Boolean(blocker) || (busy && !mine)} running={Boolean(mine?.running)}>
          {chosen === 'improve' ? 'Improve with AI' : 'Write with AI'}
        </AiButton>
      </div>
      {busy && !mine ? (
        <p className="text-[13px] leading-5 text-muted-foreground">Write with AI is working on another entry.</p>
      ) : null}
      {mine?.running ? <Spinner size={14} label={mine.progress ?? 'Writing the bullets...'} /> : null}
      {mine?.failure && !mine.running ? (
        <Notice
          tone="error"
          action={
            <Button variant="outline" size="sm" onClick={mine.dismiss}>
              Dismiss
            </Button>
          }
        >
          {mine.failure}
        </Notice>
      ) : null}
      {mine?.answer && mine.answer.length > 0 ? (
        <p role="status" className="text-[13px] leading-5 font-medium text-success">
          {mine.run?.task === 'improve' ? 'Bullets improved. Undo in the bar takes them back.' : 'Bullets written. Undo in the bar takes them back.'}
        </p>
      ) : null}
    </div>
  );
}
