'use client';

import { JOB_REPORT_REASON_LABEL, JOB_REVIEW_DETAILS_MAX, type JobReportReason } from '@tailorit/shared';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { useReportJob } from '../../report/api';

// v30 E0-WEB: "Report company information" under the Company section (13-company-enrichment.md §6.4): a job report
// with the reason company_info_wrong ("Company information is wrong"), which lands in the admin's queue (Admin › Review's
// Flags lane) with the job's company named. The job's flag dialog (features/jobs/report) lists the same reason.

/** The report's reason: always company_info_wrong. */
export const COMPANY_REPORT_REASON: JobReportReason = 'company_info_wrong';

export function CompanyReportDialog({
  jobId,
  company,
  open,
  onOpenChange,
}: {
  jobId: number;
  company: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const report = useReportJob();
  const [details, setDetails] = useState('');

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setDetails('');
      report.reset();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    report.mutate(
      { jobId, body: { reason: COMPANY_REPORT_REASON, details: details.trim() } },
      {
        onSuccess: () => {
          close(false);
          toast.success('Thanks for the report', `We will check what we show about ${company}.`);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title={JOB_REPORT_REASON_LABEL[COMPANY_REPORT_REASON]} description={`What is wrong in what we show about ${company}?`} size="md">
        <form onSubmit={submit} className="mt-5 flex flex-col gap-5" data-company-report="">
          <Field label="What is wrong" optional>
            <Textarea
              value={details}
              maxLength={JOB_REVIEW_DETAILS_MAX}
              rows={4}
              placeholder="For example: the headquarters moved, or this is another company of the same name"
              onChange={(event) => setDetails(event.target.value)}
            />
          </Field>
          {report.isError && <Notice tone="error">{userMessage(report.error)}</Notice>}
          <DialogFooter flush>
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={report.isPending}>
              Send report
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
