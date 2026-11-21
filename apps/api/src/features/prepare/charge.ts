import type { PersonPayer } from '../../core/accounts/payer';
import type { TailorStartOptions } from '../tailor/service';

// v33 SHARE-5 (PLAN F9 "Who pays"; SP v33 PLAN-sharing.md §5): every AI step of a Prepare is charged to the Prepare's
// payer (payerOfRow: who started it, B under the grant on a profile shared with them; the owner for their own), never to
// the profile's owner for B's work. The one place the runner names the payer to the AI queue and to Tailor.
//
// v33 INT-C (SHARE-3's enqueue takes a Payer): the queue gets the Payer itself, so it stores the grant (ai_tasks.grant_id,
// grant_perm) and checks it again when the task runs (the runner also checks it before every step and every AI request).
// v33 INT-1: `chargeTo` is required at every enqueue, so the runner names the payer in each task's options itself
// (runner.ts letterStep/answersStep: `chargeTo: payer`); the old chargedTo wrapper went.

/** A Prepare's tailoring's options: marked as the Prepare's (`prepare`), paid by its payer (SHARE-3's TailorStartOptions.payer). */
export function tailorOptionsFor(prepareId: string, payer: PersonPayer): TailorStartOptions {
  return { prepare: { id: prepareId }, payer };
}
