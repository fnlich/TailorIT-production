'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { keptNames } from './keptNames';

// v3.2 FILL: after a fill, the answers the person already had that the resume says otherwise were kept (a fill never
// changes an answer). This offers the resume's instead, after a yes; nothing is saved until Next or Save.

export function KeptAnswers({ kept, onUse }: { kept: readonly string[]; onUse: () => void }) {
  const [open, setOpen] = useState(false);
  const names = keptNames(kept);
  if (names.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-kept-answers="">
      <p className="text-[13px] leading-5 text-muted-foreground">Kept your answers for {names.join(', ')}.</p>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Use the resume&apos;s
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="primary"
        title="Use your resume's answers?"
        description={`Replaces ${names.join(', ')}. Nothing is saved until you press Next.`}
        confirmLabel="Use the resume's"
        focusConfirm
        onConfirm={onUse}
      />
    </div>
  );
}
