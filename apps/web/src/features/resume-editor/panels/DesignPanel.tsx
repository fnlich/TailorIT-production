'use client';

import { clsx } from 'clsx';
import {
  COLOR_PRESETS,
  COLUMN_RATIO_STEP_COUNT,
  effectiveTemplateId,
  FONT_SIZE_STEPS_PT,
  isDesignControlEditable,
  isHexColor,
  LINE_HEIGHT_STEPS,
  MARGIN_STEPS_PX,
  resolveDesign,
  RESUME_FONT_PAIRS,
  RESUME_TEMPLATES,
  SECTION_SPACING_STEPS_PX,
  stepIndexOf,
  type ResumeDocument,
} from '@tailorit/shared';
import type { EditorStore } from '../store/store';
import { PanelSection, SidePanel } from './SidePanel';

// Enhancv's Design & Font, in its order: page margins, section spacing, colours, font style, font size, line height,
// column layout and backgrounds. Every change shows on the page at once; a control the template locks is not shown.
// A template may shift a map's steps (the four after the owner's originals start on their own numbers): the step shown
// as chosen is found with the shift taken off.
// Changes to one control within a second are one undo step, so a run of clicks or a drag undoes in one go.

const BACKGROUND_NAMES: Record<string, string> = { corners: 'Corners' };

/** Enhancv's stepped controls: a row of steps, from the first word to the last. */
function Steps({
  label,
  count,
  value,
  from,
  to,
  onChange,
}: {
  label: string;
  count: number;
  value: number;
  from: string;
  to: string;
  onChange(index: number): void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label={label} className="flex items-center gap-1.5">
        {Array.from({ length: count }, (_, index) => (
          <button
            key={index}
            type="button"
            role="radio"
            aria-checked={value === index}
            aria-label={`${label} ${index + 1} of ${count}`}
            onClick={() => onChange(index)}
            className={clsx(
              'h-2.5 flex-1 rounded-tag transition-colors',
              index <= value ? 'bg-primary' : 'bg-border-strong hover:bg-control-hover',
            )}
          />
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{from}</span>
        <span>{to}</span>
      </div>
    </div>
  );
}

export function DesignPanel({ document, store, onClose }: { document: ResumeDocument; store: EditorStore; onClose(): void }) {
  const spec = RESUME_TEMPLATES[effectiveTemplateId(document)];
  const design = resolveDesign(document.design, spec);
  const editable = (control: Parameters<typeof isDesignControlEditable>[1]) => isDesignControlEditable(spec, control);
  const colors = { primary: design.primary, secondary: design.secondary };
  const setColor = (key: 'primary' | 'secondary', value: string) => {
    if (isHexColor(value)) store.setDesign({ colors: { ...colors, [key]: value.toLowerCase() } });
  };
  const ratioIndex = Math.max(0, spec.columnRatios.indexOf(design.columnRatio));

  return (
    <SidePanel title="Design & Font" onClose={onClose}>
      {editable('margins') ? (
        <PanelSection title="Page margins">
          <Steps
            label="Page margins"
            count={MARGIN_STEPS_PX.length}
            value={stepIndexOf(MARGIN_STEPS_PX, design.marginPx, spec.marginShiftPx)}
            from="Narrow"
            to="Wide"
            onChange={(margins) => store.setDesign({ margins })}
          />
        </PanelSection>
      ) : null}
      {editable('sectionSpacing') ? (
        <PanelSection title="Section spacing">
          <Steps
            label="Section spacing"
            count={SECTION_SPACING_STEPS_PX.length}
            value={stepIndexOf(SECTION_SPACING_STEPS_PX, design.sectionSpacingPx, spec.sectionSpacingShiftPx)}
            from="Compact"
            to="More space"
            onChange={(sectionSpacing) => store.setDesign({ sectionSpacing })}
          />
        </PanelSection>
      ) : null}
      {editable('colors') ? (
        <PanelSection title="Colors">
          <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label="Color pairs">
            {COLOR_PRESETS.map((preset) => {
              const chosen = preset.primary === design.primary && preset.secondary === design.secondary;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  aria-label={preset.label}
                  title={preset.label}
                  onClick={() => store.setDesign({ colors: { primary: preset.primary, secondary: preset.secondary } })}
                  className={clsx(
                    'flex h-9 items-center justify-center rounded-control border-2',
                    chosen ? 'border-primary bg-primary-50' : 'border-transparent hover:border-border-strong',
                  )}
                >
                  <span className="flex h-6 w-6 overflow-hidden rounded-tag">
                    <span className="h-full w-1/2" style={{ backgroundColor: preset.primary }} />
                    <span className="h-full w-1/2" style={{ backgroundColor: preset.secondary }} />
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex gap-4 text-[13px] text-foreground">
            {(['primary', 'secondary'] as const).map((key) => (
              <label key={key} className="flex items-center gap-2">
                <input
                  type="color"
                  value={colors[key]}
                  onChange={(event) => setColor(key, event.target.value)}
                  className="h-7 w-9 cursor-pointer rounded-tag border border-border-strong bg-transparent"
                />
                {key === 'primary' ? 'Primary' : 'Secondary'}
              </label>
            ))}
          </div>
        </PanelSection>
      ) : null}
      {editable('fontPair') ? (
        <PanelSection title="Font style">
          <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Font style">
            {RESUME_FONT_PAIRS.map((pair) => {
              const chosen = pair.id === design.fontPairId;
              return (
                <button
                  key={pair.id}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  onClick={() => store.setDesign({ fontPair: pair.id })}
                  className={clsx(
                    'flex flex-col items-start rounded-control border px-3 py-2 text-left',
                    chosen ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-low',
                  )}
                >
                  <span className="text-[15px] font-semibold text-foreground" style={{ fontFamily: pair.heading.stack }}>
                    {pair.heading.family}
                  </span>
                  <span className="text-[13px] text-muted-foreground" style={{ fontFamily: pair.body.stack }}>
                    {pair.body.family}
                    {pair.hint ? `, ${pair.hint}` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </PanelSection>
      ) : null}
      {editable('fontSize') ? (
        <PanelSection title="Font size">
          <Steps
            label="Font size"
            count={FONT_SIZE_STEPS_PT.length}
            value={stepIndexOf(FONT_SIZE_STEPS_PT, design.fontSizePt, spec.fontSizeShiftPt)}
            from="Small"
            to="Large"
            onChange={(fontSize) => store.setDesign({ fontSize })}
          />
        </PanelSection>
      ) : null}
      {editable('lineHeight') ? (
        <PanelSection title="Line height">
          <Steps
            label="Line height"
            count={LINE_HEIGHT_STEPS.length}
            value={stepIndexOf(LINE_HEIGHT_STEPS, design.lineHeight, spec.lineHeightShift)}
            from="Condensed"
            to="Spacious"
            onChange={(lineHeight) => store.setDesign({ lineHeight })}
          />
        </PanelSection>
      ) : null}
      {editable('columnRatio') ? (
        <PanelSection title="Column layout">
          <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Column layout">
            {Array.from({ length: COLUMN_RATIO_STEP_COUNT }, (_, index) => {
              const side = spec.columnRatios[index] ?? 0;
              const main = Math.round((1 - side) * 100);
              return (
                <button
                  key={index}
                  type="button"
                  role="radio"
                  aria-checked={ratioIndex === index}
                  aria-label={`Main column ${main}%`}
                  onClick={() => store.setDesign({ columnRatio: index })}
                  className={clsx(
                    'flex h-12 gap-1 rounded-control border p-1.5',
                    ratioIndex === index ? 'border-primary bg-primary-50' : 'border-border hover:bg-surface-low',
                    spec.side?.position === 'left' && 'flex-row-reverse',
                  )}
                >
                  <span className="h-full rounded-tag bg-control-strong" style={{ width: `${main}%` }} />
                  <span className="h-full flex-1 rounded-tag bg-border-strong" />
                </button>
              );
            })}
          </div>
        </PanelSection>
      ) : null}
      {editable('background') ? (
        <PanelSection title="Backgrounds">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Background">
            {['none', ...spec.backgrounds].map((id) => {
              const chosen = (design.background ?? 'none') === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  onClick={() => store.setDesign({ background: id })}
                  className={clsx(
                    'h-10 rounded-control border text-[13px]',
                    chosen ? 'border-primary bg-primary-soft font-medium text-primary-ink' : 'border-border text-muted-foreground hover:bg-surface-low',
                  )}
                >
                  {id === 'none' ? 'None' : (BACKGROUND_NAMES[id] ?? id)}
                </button>
              );
            })}
          </div>
        </PanelSection>
      ) : null}
    </SidePanel>
  );
}
