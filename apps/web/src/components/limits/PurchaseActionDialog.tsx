'use client';

// Relative, not '@/': the web tests draw these views.
import { Button, buttonClasses } from '../ui/Button';
import { Dialog, DialogClose, DialogContent, DialogFooter } from '../ui/Dialog';
import { CopyIcon, EnvelopeIcon } from '../ui/icons';
import { useToast } from '../ui/Toast';
import { LIMIT_COPY } from './copy';
import type { PurchaseAction } from './limits';

// v2.0: the body of the Subscribe and Buy credit dialogs (docs/design/v2.0/08-ui.md, "Shared pieces"), by the action's
// mode. `contact` (v2.0): the message, then the admin's email as a mailto: link with "Copy email", or "The admin has
// not set a contact email yet." `checkout` (a later payment provider): the message and "Continue to payment".

/** What the dialog shows; drawn statically by the tests. */
export function PurchaseActionBody({
  action,
  emailMissing,
  onCopyEmail,
}: {
  action: PurchaseAction;
  /** MSG_CONTACT_EMAIL_MISSING, rendered. */
  emailMissing: string;
  onCopyEmail: (email: string) => void;
}) {
  if (action.mode === 'checkout') {
    return (
      <div className="flex flex-col gap-4" data-purchase-mode="checkout">
        <p className="text-sm leading-5 text-foreground">{action.message}</p>
        <a href={action.url} className={buttonClasses({ className: 'self-start' })} rel="noopener">
          {LIMIT_COPY.continueToPayment}
        </a>
      </div>
    );
  }
  const email = action.contactEmail;
  return (
    <div className="flex flex-col gap-3" data-purchase-mode="contact">
      <p className="text-sm leading-5 text-foreground">{action.message}</p>
      {email ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-border bg-surface-low px-3 py-2.5">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <EnvelopeIcon size={16} className="shrink-0 text-muted-foreground" />
            <a
              href={`mailto:${email}`}
              className="min-w-0 text-sm leading-5 font-semibold break-all text-primary-ink underline-offset-2 hover:underline"
            >
              {email}
            </a>
          </span>
          <Button variant="outline" size="sm" icon={<CopyIcon size={14} />} onClick={() => onCopyEmail(email)}>
            {LIMIT_COPY.copyEmail}
          </Button>
        </div>
      ) : (
        <p className="text-sm leading-5 text-muted-foreground">{emailMissing}</p>
      )}
    </div>
  );
}

/** The panel inside the open dialog (its own component, so the toast is only asked for while it shows). */
function PurchaseActionPanel({ action, emailMissing }: { action: PurchaseAction; emailMissing: string }) {
  const toast = useToast();
  const copy = async (email: string) => {
    try {
      await navigator.clipboard.writeText(email);
      toast.success(LIMIT_COPY.emailCopied);
    } catch {
      toast.info(LIMIT_COPY.copyByHand, LIMIT_COPY.copyRefused);
    }
  };
  return (
    <>
      <div className="mt-4">
        <PurchaseActionBody action={action} emailMissing={emailMissing} onCopyEmail={(email) => void copy(email)} />
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline">{LIMIT_COPY.close}</Button>} />
      </DialogFooter>
    </>
  );
}

/** A Subscribe or Buy credit dialog: its title and the action's body. Focus returns to the opener on close. */
export function PurchaseActionDialog({
  open,
  onOpenChange,
  title,
  action,
  emailMissing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  action: PurchaseAction;
  emailMissing: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} size="md">
        <PurchaseActionPanel action={action} emailMissing={emailMissing} />
      </DialogContent>
    </Dialog>
  );
}
