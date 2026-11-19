'use client';

import { LinkSimpleIcon } from '@phosphor-icons/react/LinkSimple';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { AddLinksForm } from './AddLinksForm';

// v31 ADMINWEB: the Admin page's "Add links" (its header, on every tab): the paste form of Admin › Import links in a
// dialog, so an admin adds a few job links from wherever they are. The dialog keeps the last batch's progress.

export function AddLinksButton() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Outline: each tab has its own main (primary) action below the page header. */}
      <Button
        variant="outline"
        icon={<LinkSimpleIcon size={16} aria-hidden="true" />}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        data-admin-add-links=""
      >
        Add links
      </Button>
      <DialogContent
        title="Add links"
        help="TailorIT reads each posting from its own link before anyone can find it."
        size="lg"
      >
        <div className="mt-5">
          <AddLinksForm
            label="Job links to add"
            actionsLast
            actions={(submit) => (
              <DialogFooter flush className="mt-2">
                <DialogClose render={<Button variant="outline">Close</Button>} />
                {submit}
              </DialogFooter>
            )}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
