'use client';

import {
  CUSTOM_SECTION_SPEC,
  ENTRY_TOGGLES,
  MAX_CUSTOM_SECTION_TITLE_LENGTH,
  MAX_RESUME_CUSTOM_SECTIONS,
  SECTION_KIND_BY_ID,
  effectiveLayout,
  parseSectionRef,
  type ResumeDocument,
  type SectionIcon,
} from '@tailorit/shared/resume';
import { clsx } from 'clsx';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { usePublicConstants } from '@/lib/constants';
import { SectionGlyph } from '../sectionIcons';
import { sectionName } from './tools';

// Enhancv's Add section gallery: a tile per section that is off the page (each with its icon and one line on what it
// holds), "Show used sections" for the ones already on (shown, not addable), and a custom section under a title of
// the person's own, with the fields its entries have. A section switched off earlier kept its content: adding it again
// brings that back.

/** One line for the kinds the catalogue leaves without one (they were always on the page in the form editor). */
const FALLBACK_BLURBS: Readonly<Record<string, string>> = {
  summary: 'A few sentences on who you are and what you are looking for.',
  experience: 'Your roles, each with its dates, place and bullets.',
  education: 'Degrees and schools, with their dates.',
  skills: 'Your skills as tags, a list or bullets, grouped or not.',
  softSkills: 'The ways you work with people, as tags.',
  strengths: 'A few strengths, each with a line on how it showed.',
};

/** The fields a custom section's entries can have; the title is always there. */
const CUSTOM_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'subheading', label: 'Subtitle' },
  { key: 'period', label: 'Period' },
  { key: 'location', label: 'Location' },
  { key: 'description', label: 'Description' },
  { key: 'bullets', label: 'Bullets' },
];
const ALL_CUSTOM_FIELDS = ENTRY_TOGGLES.custom.map((toggle) => toggle.key);

interface Tile {
  ref: string;
  label: string;
  blurb: string;
  icon: SectionIcon;
  used: boolean;
}

/** The sections a document could add (off) or has on, custom sections included, in the catalogue's layout order. */
export function sectionTiles(document: ResumeDocument): Tile[] {
  return effectiveLayout(document).flatMap((item): Tile[] => {
    const parsed = parseSectionRef(item.ref);
    if (!parsed) return [];
    if (parsed.kind === 'custom') {
      return [{ ref: item.ref, label: sectionName(document, item.ref), blurb: 'Your custom section, with what it held.', icon: CUSTOM_SECTION_SPEC.icon, used: item.enabled }];
    }
    const kind = SECTION_KIND_BY_ID[parsed.kind];
    return [{ ref: item.ref, label: kind.label, blurb: kind.blurb || FALLBACK_BLURBS[kind.id] || kind.description, icon: kind.icon, used: item.enabled }];
  });
}

export interface AddSectionDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  document: ResumeDocument;
  onAdd(ref: string): void;
  onAddCustom(title: string, fields: readonly string[]): void;
  /** The dialog has closed (after its animation): focus may move. */
  onClosed(): void;
}

export function AddSectionDialog({ open, onOpenChange, document, onAdd, onAddCustom, onClosed }: AddSectionDialogProps) {
  const { t } = usePublicConstants();
  const [showUsed, setShowUsed] = useState(false);
  const [custom, setCustom] = useState<{ title: string; fields: string[] } | null>(null);
  const added = useRef(false);
  const tiles = sectionTiles(document);
  const visible = tiles.filter((tile) => showUsed || !tile.used);
  const customCount = document.customSections?.length ?? 0;
  const atCap = customCount >= MAX_RESUME_CUSTOM_SECTIONS;

  const finish = () => {
    added.current = true;
    onOpenChange(false);
  };
  const addCustom = () => {
    if (!custom || atCap) return;
    const title = custom.title.trim();
    if (!title) return;
    onAddCustom(title, custom.fields);
    finish();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) added.current = false;
        else setCustom(null);
        onOpenChange(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed();
      }}
    >
      <DialogContent
        size="xl"
        title="Add a section"
        help="A section you removed comes back with what it held."
        finalFocus={() => !added.current}
      >
        <div className="mt-4 flex items-center justify-end">
          <Switch checked={showUsed} onCheckedChange={setShowUsed} label="Show used sections" labelPosition="start" />
        </div>
        <div className="-mx-1 mt-3 flex max-h-[min(64vh,36rem)] flex-col gap-3 overflow-y-auto px-1 pb-1">
          {visible.length > 0 ? (
            <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" aria-label="Sections">
              {visible.map((tile) => (
                <li key={tile.ref}>
                  <button
                    type="button"
                    disabled={tile.used}
                    aria-label={tile.used ? `${tile.label}, on the page already` : `Add ${tile.label}`}
                    aria-describedby={`add-section-${tile.ref}`}
                    onClick={() => {
                      onAdd(tile.ref);
                      finish();
                    }}
                    className={clsx(
                      'flex h-full w-full items-start gap-3 rounded-card border border-border bg-surface p-3.5 text-left',
                      'transition-[border-color,background-color] duration-150',
                      tile.used ? 'cursor-not-allowed opacity-60' : 'hover:border-primary hover:bg-primary-50 hover:shadow-card',
                    )}
                  >
                    <SectionGlyph icon={tile.icon} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-sm leading-5 font-semibold text-foreground">
                        {tile.label}
                        {tile.used ? <Badge tone="neutral">On the page</Badge> : null}
                      </span>
                      {/* v32 COPY (E5): what the section holds describes the tile (never a visible line). */}
                      <span id={`add-section-${tile.ref}`} hidden>
                        {tile.blurb}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Every section is on the page already.</p>
          )}
          <div className="stitch rounded-card bg-surface-low p-3.5">
            {custom ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  addCustom();
                }}
              >
                <div className="flex items-start gap-3">
                  <SectionGlyph icon={CUSTOM_SECTION_SPEC.icon} />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <p className="text-sm leading-5 font-semibold text-foreground">{CUSTOM_SECTION_SPEC.label}</p>
                    <Input
                      aria-label="Custom section title"
                      placeholder="Section title, e.g. Patents"
                      maxLength={MAX_CUSTOM_SECTION_TITLE_LENGTH}
                      value={custom.title}
                      autoFocus
                      onChange={(event) => setCustom({ ...custom, title: event.target.value })}
                    />
                  </div>
                </div>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-xs font-medium text-muted-foreground">Each entry has</legend>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    <Checkbox label="Title" checked disabled onCheckedChange={() => undefined} />
                    {CUSTOM_FIELDS.map((field) => (
                      <Checkbox
                        key={field.key}
                        label={field.label}
                        checked={custom.fields.includes(field.key)}
                        onCheckedChange={(on) =>
                          setCustom({
                            ...custom,
                            fields: on ? [...custom.fields, field.key] : custom.fields.filter((key) => key !== field.key),
                          })
                        }
                      />
                    ))}
                  </div>
                </fieldset>
                <DialogFooter flush>
                  <Button variant="outline" onClick={() => setCustom(null)}>
                    Back
                  </Button>
                  <Button type="submit" disabled={!custom.title.trim() || atCap}>
                    Add section
                  </Button>
                </DialogFooter>
              </form>
            ) : (
              <button
                type="button"
                disabled={atCap}
                onClick={() => setCustom({ title: '', fields: [...ALL_CUSTOM_FIELDS] })}
                className="flex w-full items-start gap-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
              >
                <SectionGlyph icon={CUSTOM_SECTION_SPEC.icon} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm leading-5 font-semibold text-foreground">{CUSTOM_SECTION_SPEC.label}</span>
                  <span className="text-[13px] leading-[18px] text-muted-foreground">
                    {atCap ? t('MSG_CUSTOM_SECTIONS_MAX', { max: MAX_RESUME_CUSTOM_SECTIONS }) : CUSTOM_SECTION_SPEC.blurb}
                  </span>
                </span>
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
