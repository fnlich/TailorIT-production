'use client';

import type { JobAnalysisView } from '@tailorit/shared';
import { clsx } from 'clsx';
import { useState } from 'react';
import { Chip } from '@/components/ui/Chip';
import { HelpTip } from '@/components/ui/HelpTip';
import { SegmentedControl, TabPanel } from '@/components/ui/SegmentedControl';
import { SkeletonText } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { usePublicConstants, type PublicMessageKey } from '@/lib/constants';
import { DetailCardTitle, detailCardClasses } from './DetailCard';
import { jobFacetGroups, type JobFacetGroup } from './facets';

/** v31 FIX-JOBS: the summary's parts in TailorIT's order and words: the work first, then what the posting asks for. */
const PARTS: ReadonlyArray<{ key: 'responsibilities' | 'requirements' | 'desired'; title: PublicMessageKey }> = [
  { key: 'responsibilities', title: 'LABEL_JOB_ROLE_DUTIES' },
  { key: 'requirements', title: 'LABEL_JOB_ROLE_ASKS' },
  { key: 'desired', title: 'LABEL_JOB_ROLE_NICE' },
];

/**
 * Styles for the posting's own HTML (sanitized by the API): paragraphs, headings, lists and links in the page's
 * type scale. Descendant variants keep them inside this block.
 */
const POSTING_HTML = clsx(
  'text-[15px] leading-6 text-foreground break-words',
  '[&_p]:my-3 [&_p:first-child]:mt-0',
  '[&_h1]:mt-6 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold',
  '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold',
  '[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3:first-child]:mt-0',
  '[&_h4]:mt-5 [&_h4]:mb-2 [&_h4]:text-base [&_h4]:font-semibold',
  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1.5 [&_li]:pl-1',
  '[&_a]:text-primary-ink [&_a]:underline [&_a]:underline-offset-2',
  '[&_strong]:font-semibold [&_b]:font-semibold',
  '[&_table]:my-3 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:p-2',
);

/** A part's heading inside the role (an h4 under the section's h3). */
const PART_TITLE = 'text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase';

/**
 * "Also mentioned": the posting's soft skills, certifications and industries, one labelled row of chips per group that
 * has any (its hard skills are the Skills card's).
 */
function AlsoMentioned({ groups }: { groups: JobFacetGroup[] }) {
  const { t } = usePublicConstants();
  return (
    <section aria-label={t('LABEL_JOB_ROLE_ALSO')} data-job-facets>
      <h4 className={PART_TITLE}>{t('LABEL_JOB_ROLE_ALSO')}</h4>
      <dl className="mt-3 flex flex-col gap-3">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-1.5 sm:flex-row sm:gap-4">
            <dt className="shrink-0 text-sm leading-5 font-medium text-muted-foreground sm:w-28 sm:leading-7">{group.label}</dt>
            <dd className="min-w-0 flex-1">
              <ul aria-label={group.label} data-job-facet={group.key} className="flex flex-wrap gap-2">
                {group.items.map((item) => (
                  <li key={item} className="max-w-full">
                    <Chip size="sm" tone="outline">
                      {item}
                    </Chip>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Summary({ analysis }: { analysis: JobAnalysisView }) {
  const { t } = usePublicConstants();
  const parts = PARTS.filter((part) => analysis[part.key].length > 0);
  const facets = jobFacetGroups(analysis);
  return (
    <div className="flex flex-col gap-6" data-role-summary="">
      {parts.map((part) => (
        <section key={part.key} aria-label={t(part.title)} data-role-part={part.key}>
          <h4 className={PART_TITLE}>{t(part.title)}</h4>
          <ul className="mt-2.5 flex flex-col gap-2 text-[15px] leading-6 text-foreground">
            {analysis[part.key].map((item, index) => (
              <li key={`${index}-${item}`} className="relative pl-5">
                {/* A short tape mark instead of a round bullet. */}
                <span aria-hidden="true" className="absolute top-[11px] left-0 h-0.5 w-2.5 rounded-full bg-tape-strong" />
                {item}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {facets.length > 0 && <AlsoMentioned groups={facets} />}
    </div>
  );
}

/** Which part of About the job shows. */
type AboutView = 'summary' | 'posting';

/**
 * v33 JOBDETAIL (F2): "About the job", a card with a Summary | Full posting switch at its title's right. Summary is the
 * analysis's bullets (what you'd do, what they ask for, nice to have, also mentioned); Full posting is the posting's own
 * HTML (sanitized by the API). It opens on the summary when there is one. With no summary (none yet, or the analysis
 * could not be loaded) it shows the full posting, Summary off, and why behind a "?" (v32 JOBS2). A quiet "Refining…"
 * shows while the AI analysis is made; when it lands the summary changes in place and a chosen part stays chosen.
 */
export function AboutJob({
  analysis,
  analysisPending,
  analysisFailed = false,
  descriptionHtml,
  className,
}: {
  analysis: JobAnalysisView | undefined;
  analysisPending: boolean;
  /** The analysis could not be loaded: the full posting is shown instead of a summary. */
  analysisFailed?: boolean;
  descriptionHtml: string;
  className?: string;
}) {
  const { t } = usePublicConstants();
  const [chosen, setChosen] = useState<AboutView | null>(null);
  const hasSummary = analysis ? analysis.requirements.length + analysis.responsibilities.length + analysis.desired.length > 0 : false;
  const loading = !analysis && !analysisFailed && analysisPending;
  // No summary to read: the posting itself is the job's text.
  const postingOnly = !loading && !hasSummary;
  const view: AboutView = postingOnly ? 'posting' : (chosen ?? 'summary');
  const title = t('LABEL_JOB_ABOUT_ROLE');
  const summaryLabel = t('LABEL_JOB_SUMMARY');
  const postingLabel = t('LABEL_JOB_FULL_POSTING');

  const posting = descriptionHtml ? (
    <div className={POSTING_HTML} dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
  ) : (
    <p className="text-[15px] text-muted-foreground">This posting has no description.</p>
  );

  const status = analysis?.refining ? (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <Spinner size={12} />
      Refining…
    </span>
  ) : postingOnly ? (
    // v32 JOBS2 (E4, E5): why there is no summary, behind a "?" by the title.
    <span className="inline-flex items-center" data-no-summary="">
      <HelpTip label={summaryLabel}>{analysisFailed && !analysis ? t('MSG_JOB_SUMMARY_FAILED') : t('MSG_JOB_NO_SUMMARY')}</HelpTip>
    </span>
  ) : null;

  if (loading) {
    return (
      <section aria-labelledby="about-the-role" className={clsx(detailCardClasses(), className)} data-about-role="">
        <DetailCardTitle id="about-the-role" title={title} />
        <SkeletonText lines={6} className="mt-4" />
      </section>
    );
  }

  return (
    <section aria-labelledby="about-the-role" className={clsx(detailCardClasses(), className)} data-about-role="">
      <SegmentedControl<AboutView>
        items={[
          { value: 'summary', label: summaryLabel, disabled: postingOnly },
          { value: 'posting', label: postingLabel },
        ]}
        value={view}
        onValueChange={setChosen}
        aria-label={title}
        size="sm"
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-4"
        listClassName="col-start-2 row-start-1 max-sm:h-11"
      >
        <div className="col-start-1 row-start-1 min-w-0">
          <DetailCardTitle id="about-the-role" title={title}>
            {status}
          </DetailCardTitle>
        </div>
        <TabPanel value="summary" className="col-span-2">
          {hasSummary && analysis && <Summary analysis={analysis} />}
        </TabPanel>
        <TabPanel value="posting" className="col-span-2">
          <div data-full-posting="">{posting}</div>
        </TabPanel>
      </SegmentedControl>
    </section>
  );
}
