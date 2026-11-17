'use client';

import { CameraIcon } from '@phosphor-icons/react/Camera';
import { Toolbar } from '@base-ui/react/toolbar';
import { useRef, useState } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import { IconButton } from '@/components/ui/IconButton';
import { GearSixIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import { HIDE_FIELDS_HINT } from './EntryToolbar';
import { PanelGroup, ToolPopover, ToolbarShell } from './parts';
import type { HeaderTools } from './tools';
import type { ToolbarCommands } from './useToolbarCommands';

// The bar above the header: Settings (the details under the name shown or hidden, the name in capitals, the years of
// experience, which are not printed) and, on a template that prints one, the photo (add or replace it through the
// photo dialog, hide it, round or square).

export function HeaderToolbar({
  tools,
  commands,
  settingsHint = 0,
  onEscape,
}: {
  tools: HeaderTools;
  commands: ToolbarCommands;
  /** Counts Backspace in an empty detail of the header: each points at Settings. */
  settingsHint?: number;
  onEscape(): void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const photoButton = useRef<HTMLButtonElement | null>(null);
  const photo = tools.photo;
  return (
    <ToolbarShell label="Tools for the header" onEscape={onEscape}>
      <ToolPopover
        label="Header settings"
        tooltip="Settings"
        icon={<GearSixIcon size={16} />}
        title="Header settings"
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        width="w-64"
        hint={{ count: settingsHint, text: HIDE_FIELDS_HINT }}
      >
        <div className="flex flex-col gap-3 py-1">
          <PanelGroup label="Show">
            {tools.toggles.map((toggle) => (
              <Checkbox
                key={toggle.key}
                label={toggle.label}
                checked={toggle.shown}
                onCheckedChange={(shown) => commands.setHeaderField(toggle.key, toggle.label, shown)}
              />
            ))}
          </PanelGroup>
          <PanelGroup className="border-t border-border pt-3">
            <Checkbox label="Name in capitals" checked={tools.uppercaseName} onCheckedChange={commands.setUppercaseName} />
          </PanelGroup>
          <PanelGroup label="Years of experience" className="border-t border-border pt-3">
            <YearsField years={tools.years} onChange={commands.setYears} />
            <p className="text-[13px] leading-5 text-muted-foreground">Not printed. Write with AI pitches your bullets to it.</p>
          </PanelGroup>
        </div>
      </ToolPopover>
      {photo ? (
        <Menu>
          <Toolbar.Button
            render={
              <MenuTrigger
                render={
                  <IconButton
                    ref={photoButton}
                    label="Photo"
                    tooltip="Photo"
                    icon={<CameraIcon size={16} />}
                    size="sm"
                    variant="ghost"
                  />
                }
              />
            }
          />
          <MenuContent width="w-48" aria-label="Photo">
            <MenuItem
              onClick={() => {
                if (photoButton.current) commands.choosePhoto(photoButton.current);
              }}
            >
              {photo.present ? 'Replace photo' : 'Add photo'}
            </MenuItem>
            {photo.present ? (
              <>
                <MenuItem onClick={commands.hidePhoto}>Hide photo</MenuItem>
                <MenuSeparator />
                <MenuRadioGroup
                  label="Shape"
                  value={photo.shape}
                  onValueChange={(shape) => commands.setPhotoShape(shape === 'square' ? 'square' : 'round')}
                >
                  <MenuRadioItem value="round">Round</MenuRadioItem>
                  <MenuRadioItem value="square">Square</MenuRadioItem>
                </MenuRadioGroup>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      ) : null}
    </ToolbarShell>
  );
}

/** The number as typed ("7." on its way to "7.5"); a valid one, or none, goes to the store at once. */
export function YearsField({ years, onChange }: { years: number | null; onChange(years: number | null): void }) {
  const [text, setText] = useState(years === null ? '' : String(years));
  const [shown, setShown] = useState(years);
  if (years !== shown) {
    // Changed elsewhere (Undo): the box follows.
    setShown(years);
    setText(years === null ? '' : String(years));
  }
  return (
    <Input
      type="number"
      min={0}
      max={80}
      step={0.5}
      inputMode="decimal"
      aria-label="Years of experience"
      placeholder="e.g. 4"
      value={text}
      onChange={(event) => {
        const typed = event.target.value;
        setText(typed);
        const parsed = typed.trim() === '' ? null : Number(typed);
        if (parsed !== null && !(Number.isFinite(parsed) && parsed >= 0 && parsed <= 80)) return;
        const next = parsed === null ? null : Math.round(parsed * 10) / 10;
        setShown(next);
        onChange(next);
      }}
    />
  );
}
