'use client';

import { usePublicConstants } from '@/lib/constants';
import { operatorOf, type Operator } from './operator';
import { TextLink } from './prose';

// v34 PUBLIC: the operator's details inside the public pages' sentences, from the public constants (operator.ts). The
// layout hands the server's answer to the query cache, so they are known at the first paint; when they are not (the
// server could not read them and the browser's read is pending or failed) the pages never say "no contact": the review's
// finding 3.

export interface OperatorState {
  operator: Operator;
  /** True once the server's values are in (unset values are then really unset). */
  loaded: boolean;
}

/** The operator, read from the public constants, and whether they are the server's values. */
export function useOperator(): OperatorState {
  const { values, isLoaded } = usePublicConstants();
  return { operator: operatorOf(values), loaded: isLoaded };
}

/** Said in place of a name the operator has not set (or that is not known yet). */
export const NO_OPERATOR_NAME = 'the operator of this service';
/** Said when the operator has set no contact address. */
export const NO_CONTACT = 'The operator has not published a contact address yet.';
/** Said when the contact address is not known: the constants did not load. */
export const CONTACT_UNKNOWN = "The contact address didn't load. Reload the page to see it.";

/** The operator's name, or "the operator of this service". */
export function OperatorName({ state }: { state: OperatorState }) {
  if (!state.operator.name) return <>{NO_OPERATOR_NAME}</>;
  return <span data-operator-name="">{state.operator.name}</span>;
}

/** " Website: example.com." when one is set. */
export function OperatorWebsite({ state }: { state: OperatorState }) {
  const { website, websiteLabel } = state.operator;
  if (!website || !websiteLabel) return null;
  return (
    <>
      {' '}
      Website: <TextLink href={website}>{websiteLabel}</TextLink>.
    </>
  );
}

/** The contact address as a mail link; the sentence that there is none only once the values are known. */
export function ContactAddress({ state }: { state: OperatorState }) {
  const { contactEmail } = state.operator;
  if (contactEmail) {
    return (
      <>
        Write to <TextLink href={`mailto:${contactEmail}`}>{contactEmail}</TextLink>.
      </>
    );
  }
  if (!state.loaded) return <span data-contact-unknown="">{CONTACT_UNKNOWN}</span>;
  return <span data-no-contact="">{NO_CONTACT}</span>;
}
