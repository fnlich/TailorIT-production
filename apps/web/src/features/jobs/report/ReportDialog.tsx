'use client';

import { JOB_REPORT_REASONS, JOB_REPORT_REASON_LABEL, type JobReportReason } from '@tailorit/shared';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { useReportJob } from './api';
import { detailsHintOf, detailsMaxOf, detailsPlaceholderOf, reportThanksOf } from './copy';

// v30 X1-WEB (14 §5.4): the reasons are the contract's (JOB_REPORT_REASONS, with E0's "Company information is wrong").
// "The job is no longer open" files a closed report into Admin › Review beside the extension's, so its details take
// that report's cap (JOB_REVIEW_DETAILS_MAX); a longer text keeps the button off and says why in MSG_TEXT_TOO_LONG's
// words.
const REASONS = JOB_REPORT_REASONS.map((reason) => ({ value: reason, label: JOB_REPORT_REASON_LABEL[reason] }));

/** The flag button's dialog: why the posting is wrong, plus optional details, for the admin console. */
export function ReportDialog({
  jobId,
  jobTitle,
  open,
  onOpenChange,
}: {
  jobId: number;
  jobTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const { t } = usePublicConstants();
  const report = useReportJob();
  const [reason, setReason] = useState<JobReportReason | null>(null);
  const [details, setDetails] = useState('');
  const max = detailsMaxOf(reason);
  const tooLong = details.trim().length > max;

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setReason(null);
      setDetails('');
      report.reset();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!reason || tooLong) return;
    report.mutate(
      { jobId, body: { reason, details: details.trim() } },
      {
        onSuccess: () => {
          close(false);
          toast.success('Thanks for the report', reportThanksOf(reason));
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Report this job" description={`What is wrong with "${jobTitle}"?`} size="md">
        <form onSubmit={submit} className="mt-5 flex flex-col gap-5">
          <RadioGroup aria-label="Reason" options={REASONS} value={reason} onValueChange={setReason} />
          <Field label="Details" optional hint={detailsHintOf(reason) ?? undefined} error={tooLong ? t('MSG_TEXT_TOO_LONG', { max }) : undefined}>
            <Textarea
              value={details}
              maxLength={max}
              rows={3}
              placeholder={detailsPlaceholderOf(reason)}
              onChange={(event) => setDetails(event.target.value)}
              data-report-details=""
            />
          </Field>
          {report.isError && <Notice tone="error">{userMessage(report.error)}</Notice>}
          <DialogFooter flush>
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!reason || tooLong} loading={report.isPending}>
              Report job
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
