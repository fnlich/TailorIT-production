'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { HelpTip } from '@/components/ui/HelpTip';
import { CheckIcon, SparkleIcon } from '@/components/ui/icons';
import { usePublicConstants } from '@/lib/constants';
import { TailorDialog } from '../../tailor/TailorDialog';
import type { TailorTarget } from '../../tailor/tailor';
import { DetailCard, detailCardClasses } from './DetailCard';

/**
 * v33 JOBDETAIL (F2): "Tailor for this job", the card with the tape along its top: its one primary button, "Tailor my
 * resume" (v33 INT-A: the owner's words, LABEL_JOB_DETAIL_TAILOR; the dialog it opens keeps "Tailor a resume", v1.4 E,
 * decision 16), and what tailoring does behind its "?". Shown once the match is read and there is a resume to tailor.
 * v33 FIX-1 (the owner's "see job details at once"): the button is the card (its title, "Tailor for this job", names the
 * section for screen readers only), so it sits in the first screen at 1440 x 900 under Requirements and Skills.
 */
export function TailorCard({ tailor }: { tailor: TailorTarget }) {
  const { t } = usePublicConstants();
  const [tailoring, setTailoring] = useState(false);
  const title = t('LABEL_JOB_TAILOR_TITLE');
  return (
    <section aria-labelledby="job-tailor" className={detailCardClasses('tape')} data-tailor-section="">
      <span aria-hidden="true" className="tape-ticks absolute inset-x-0 top-0 h-1.5 bg-tape" />
      <h3 id="job-tailor" className="sr-only" data-detail-card-title="">
        {title}
      </h3>
      <div className="flex items-center gap-2">
        <Button className="min-w-0 flex-1" icon={<SparkleIcon size={16} weight="fill" />} onClick={() => setTailoring(true)} data-tailor-open="">
          {t('LABEL_JOB_DETAIL_TAILOR')}
        </Button>
        <HelpTip label={title}>{t('MSG_JOB_TAILOR_LEAD')}</HelpTip>
      </div>
      <TailorDialog open={tailoring} onOpenChange={setTailoring} target={tailor} />
    </section>
  );
}

/** v33 JOBDETAIL (F2): the posting's benefits, read from its own words (none: no card). */
export function BenefitsCard({ benefits }: { benefits: readonly string[] | undefined }) {
  const { t } = usePublicConstants();
  if (!benefits || benefits.length === 0) return null;
  const title = t('LABEL_JOB_BENEFITS');
  return (
    <DetailCard id="job-benefits" title={title} data-benefits-card="">
      <ul aria-label={title} className="flex flex-col gap-2">
        {benefits.map((benefit) => (
          <li key={benefit} className="flex items-start gap-2 text-sm leading-5 break-words text-foreground">
            <CheckIcon size={14} weight="bold" aria-hidden="true" className="mt-[3px] shrink-0 text-primary" />
            <span className="min-w-0">{benefit}</span>
          </li>
        ))}
      </ul>
    </DetailCard>
  );
}
