'use client';

import { JOB_LINK_MAX_CHARS, JOB_ROW_MAX_CHARS } from '@tailorit/shared';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { userMessage } from '@/lib/api';
import type { StartedImport } from '../../../imports/api';
import { EMPTY_LINK_DETAILS, OneLinkFields, filledDetails, type LinkDetailLimits, type LinkDetails } from '../../../imports/OneLinkFields';
import { importOneLink } from './api';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1 "One link", §2): Admin › Import › One link: the link (required) and
// its details (Company, Title, Description, Rate, Location), each optional and shown directly. TailorIT reads the
// posting from the link; the details make a job held for review only when it cannot (H2), and Rate is its pay when the
// description states none (H4). An import of its own, one run on Runs ("1 link").

/** An import row's limits (PLAN H1). */
const ROW_LIMITS: LinkDetailLimits = { ...JOB_ROW_MAX_CHARS };

export function OneLinkImport({ onStarted }: { onStarted: (started: StartedImport) => void }) {
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [details, setDetails] = useState<LinkDetails>(EMPTY_LINK_DETAILS);
  const start = useMutation({
    mutationFn: () => importOneLink({ link: link.trim(), ...filledDetails(details) }),
    onSuccess: (started) => {
      setLink('');
      setDetails(EMPTY_LINK_DETAILS);
      onStarted(started);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!link.trim()) {
      setLinkError('Paste the job link.');
      return;
    }
    setLinkError(null);
    start.mutate();
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4" data-import-one-link="">
      <Field label="Job link" required error={linkError} hint="The posting's own page; TailorIT reads the job from it.">
        <Input
          type="url"
          inputMode="url"
          value={link}
          maxLength={JOB_LINK_MAX_CHARS}
          placeholder="https://"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setLink(event.target.value);
            setLinkError(null);
          }}
        />
      </Field>
      <OneLinkFields details={details} onChange={setDetails} limits={ROW_LIMITS} disabled={start.isPending} />
      {start.isError && <Notice tone="error">{userMessage(start.error)}</Notice>}
      <div className="flex justify-end border-t border-divider-soft pt-4">
        <Button type="submit" loading={start.isPending} data-import-start="">
          Import the link
        </Button>
      </div>
    </form>
  );
}
