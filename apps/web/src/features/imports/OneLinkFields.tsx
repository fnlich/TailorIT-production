'use client';

import type { ReactNode, Ref } from 'react';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1 "One link (with details)"; PLAN H1): a job's details beside its link:
// Company, Title, Description (a textarea), Rate and Location, each optional and shown directly. TailorIT uses them only
// when it cannot read the link (H2); Rate is the pay when the description states none (H4). Shared by Admin › Import ›
// One link and Jobs › Add job › One link's "Add details (optional)".

export interface LinkDetails {
  company: string;
  title: string;
  description: string;
  rate: string;
  location: string;
}

export const EMPTY_LINK_DETAILS: LinkDetails = { company: '', title: '', description: '', rate: '', location: '' };

/** The longest text each detail takes (the caller's contract: an import row's, or Add job's). */
export type LinkDetailLimits = Record<keyof LinkDetails, number>;

/** The details typed, trimmed; empty ones left out. */
export function filledDetails(details: LinkDetails): Partial<LinkDetails> {
  const out: Partial<LinkDetails> = {};
  for (const key of Object.keys(details) as (keyof LinkDetails)[]) {
    const value = details[key].trim();
    if (value) out[key] = value;
  }
  return out;
}

export interface OneLinkFieldsProps {
  details: LinkDetails;
  onChange: (next: LinkDetails) => void;
  limits: LinkDetailLimits;
  disabled?: boolean;
  /** Errors by field ("Required" for a title or company TailorIT needs). */
  errors?: Partial<Record<keyof LinkDetails, ReactNode>>;
  /** Which fields are required (the details step of a link TailorIT could not read: title and company). */
  required?: ReadonlyArray<keyof LinkDetails>;
  /** The title field's ref (focus goes there in the details step). */
  titleRef?: Ref<HTMLInputElement>;
}

export function OneLinkFields({ details, onChange, limits, disabled = false, errors = {}, required = [], titleRef }: OneLinkFieldsProps) {
  const set = (key: keyof LinkDetails) => (value: string) => onChange({ ...details, [key]: value });
  const optional = (key: keyof LinkDetails) => !required.includes(key);
  return (
    <div className="grid gap-4 sm:grid-cols-2" data-link-details="">
      <Field label="Company" optional={optional('company')} required={!optional('company')} error={errors.company}>
        <Input
          value={details.company}
          maxLength={limits.company}
          autoComplete="organization"
          disabled={disabled}
          onChange={(event) => set('company')(event.target.value)}
        />
      </Field>
      <Field label="Job title" optional={optional('title')} required={!optional('title')} error={errors.title}>
        <Input
          ref={titleRef}
          value={details.title}
          maxLength={limits.title}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => set('title')(event.target.value)}
        />
      </Field>
      <Field label="Description" optional hint="The posting's text; HTML is turned into plain text." className="sm:col-span-2">
        <Textarea
          value={details.description}
          rows={4}
          maxLength={limits.description}
          disabled={disabled}
          onChange={(event) => set('description')(event.target.value)}
        />
      </Field>
      <Field label="Rate" optional hint='The pay as written ("$40/hr", "90k-110k"), used when the description states none.'>
        <Input value={details.rate} maxLength={limits.rate} autoComplete="off" disabled={disabled} onChange={(event) => set('rate')(event.target.value)} />
      </Field>
      <Field label="Location" optional>
        <Input
          value={details.location}
          maxLength={limits.location}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => set('location')(event.target.value)}
        />
      </Field>
    </div>
  );
}
