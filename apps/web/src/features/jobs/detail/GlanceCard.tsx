'use client';

import { CLEARANCE_FILTER_LABEL, type ExperienceLevel, type JobGlance, type LevelMatch } from '@tailorit/shared';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { HelpTip } from '@/components/ui/HelpTip';
import { CheckCircleIcon, InfoIcon, ShieldCheckIcon, WarningCircleIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { usePublicConstants } from '@/lib/constants';
import { CertificateIcon, GraduationCapIcon, IdentificationCardIcon, StepsIcon } from '../icons';
import { DetailCard } from './DetailCard';
import { educationText, experienceMark, experienceText, type GlanceMark } from './glance';

/**
 * A row's mark: a green check (meets), an amber mark (below what it asks; another level than the ones the person looks
 * for), or nothing. Focusable, its words its name and its tooltip, so a keyboard and a screen reader get them.
 */
function VerdictMark({
  mark,
  lines,
  levelMatch,
}: {
  mark: Exclude<GlanceMark, 'unknown'>;
  lines: readonly string[];
  /** The level check's state, when the mark is the level check's (its v3.1 hook). */
  levelMatch?: 'match' | 'mismatch';
}) {
  const text = lines.join(' ');
  const ok = mark === 'meets';
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-1">
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      }
    >
      <span
        role="img"
        tabIndex={0}
        aria-label={text}
        data-glance-mark={mark}
        data-level-match={levelMatch}
        className={clsx('inline-flex shrink-0 rounded-full outline-offset-2', ok ? 'text-success' : 'text-warning')}
      >
        {ok ? <CheckCircleIcon size={18} weight="fill" /> : mark === 'below' ? <WarningCircleIcon size={18} weight="fill" /> : <InfoIcon size={18} weight="fill" />}
      </span>
    </Tooltip>
  );
}

/** One row: its icon tile, its name over its value (and a detail line), and its mark at the right. */
function GlanceRow({
  icon,
  label,
  children,
  detail,
  mark,
  row,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
  detail?: ReactNode;
  mark?: ReactNode;
  row: string;
}) {
  // A <dl>'s group holds its <dt> and <dd> only: the icon tile sits in the <dt>, drawn in the row's left gutter.
  return (
    <div className="group relative min-w-0 py-2.5 pl-11 first:pt-0 last:pb-0" data-glance-row={row}>
      <dt className="text-xs leading-4 text-muted-foreground">
        <span
          className="absolute top-3 left-0 flex size-8 items-center justify-center rounded-control bg-primary-soft text-primary group-first:top-0.5 [&_svg]:size-[18px]"
          aria-hidden="true"
        >
          {icon}
        </span>
        {label}
      </dt>
      <dd className="mt-0.5 flex items-start justify-between gap-2">
        <span className="min-w-0 text-sm leading-5 font-medium break-words text-foreground">
          {children}
          {detail && <span className="block text-[13px] leading-5 font-normal text-muted-foreground">{detail}</span>}
        </span>
        {mark}
      </dd>
    </div>
  );
}

export interface GlanceFallback {
  /** The job's levels (its own, else its analysis's). */
  levels: readonly ExperienceLevel[];
  /** The analysis's required years. */
  requiredYears?: number | null;
  /** The job's degree as written. */
  degree: string | null;
}

/**
 * v33 JOBDETAIL (F2): "Requirements at a glance": experience (levels and years), education ("Bachelor's or higher",
 * "or equivalent experience"), up to four required licences and certifications, H1B and clearance. Each row's mark is
 * the API's verdict (the person's own numbers stay on the server); a side that does not say leaves the row without a
 * mark, and the person's side unknown puts the way to know it behind a "?". Without the API's glance (it failed, or an
 * older API) the rows show the job's side alone.
 */
export function GlanceCard({
  glance,
  pending,
  levelMatch,
  fallback,
  sponsorsH1b,
  requiresClearance,
}: {
  glance: JobGlance | undefined;
  pending: boolean;
  levelMatch: LevelMatch | undefined;
  fallback: GlanceFallback;
  sponsorsH1b: boolean | null;
  requiresClearance: boolean | null;
}) {
  const { t } = usePublicConstants();
  const notStated = t('LABEL_JOB_GLANCE_NOT_STATED');
  const unknownTip = (label: string) => <HelpTip label={label}>{t('MSG_JOB_GLANCE_UNKNOWN')}</HelpTip>;
  const verdictLine = (mark: GlanceMark) => (mark === 'meets' ? t('MSG_JOB_GLANCE_MEETS') : mark === 'below' ? t('MSG_JOB_GLANCE_BELOW') : '');

  let body: ReactNode;
  if (pending) {
    body = (
      <div className="flex flex-col gap-4" aria-hidden="true">
        {[0, 1].map((index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="size-8" rounded="control" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-36" />
            </div>
          </div>
        ))}
      </div>
    );
  } else {
    const experienceLabel = t('LABEL_JOB_GLANCE_EXPERIENCE');
    const educationLabel = t('LABEL_JOB_GLANCE_EDUCATION');
    const certificationsLabel = t('LABEL_JOB_GLANCE_CERTIFICATIONS');
    const experience = glance
      ? experienceText(glance.experience.levels, glance.experience.minYears)
      : experienceText(fallback.levels, fallback.requiredYears);
    const experienceCheck = experienceMark(glance?.experience.verdict ?? 'unknown', levelMatch);
    const experienceMarkValue = experienceCheck.mark;
    // The years' verdict in words first (when they decide), then the level lines.
    const experienceLines = [experienceCheck.source === 'years' ? verdictLine(experienceMarkValue) : '', ...experienceCheck.lines].filter(Boolean);
    const education = glance ? educationText(glance.education) : (fallback.degree ?? '');
    const educationVerdict = glance?.education.verdict ?? 'unknown';
    const certifications = glance?.certifications ?? [];
    const anyUnknownCertification = certifications.some((entry) => entry.verdict === 'unknown');

    body = (
      <dl className="flex flex-col divide-y divide-divider-soft">
        <GlanceRow
          row="experience"
          icon={<StepsIcon />}
          label={experienceLabel}
          mark={
            !experience ? undefined : experienceMarkValue === 'unknown' ? (
              // The years are what the profile can answer (levels alone have nothing to add).
              glance && glance.experience.minYears !== null ? unknownTip(experienceLabel) : undefined
            ) : (
              <VerdictMark
                mark={experienceMarkValue}
                lines={experienceLines}
                levelMatch={experienceCheck.source === 'level' && levelMatch && levelMatch.state !== 'none' ? levelMatch.state : undefined}
              />
            )
          }
        >
          {experience || <span className="font-normal text-muted-foreground">{notStated}</span>}
        </GlanceRow>
        <GlanceRow
          row="education"
          icon={<GraduationCapIcon />}
          label={educationLabel}
          detail={glance?.education.orEquivalent && glance.education.degreeLevel !== 'none' ? t('LABEL_JOB_GLANCE_EQUIVALENT') : undefined}
          mark={
            !education ? undefined : educationVerdict === 'unknown' ? (
              // "or equivalent experience" says the rest when the posting takes it.
              glance && !glance.education.orEquivalent ? unknownTip(educationLabel) : undefined
            ) : (
              <VerdictMark mark={educationVerdict} lines={[verdictLine(educationVerdict)]} />
            )
          }
        >
          {education || <span className="font-normal text-muted-foreground">{notStated}</span>}
        </GlanceRow>
        {certifications.length > 0 && (
          <GlanceRow
            row="certifications"
            icon={<CertificateIcon />}
            label={certificationsLabel}
            mark={anyUnknownCertification ? unknownTip(certificationsLabel) : undefined}
          >
            <ul className="flex flex-col gap-1" aria-label={certificationsLabel}>
              {certifications.map((entry) => (
                <li key={entry.name} className="flex flex-wrap items-center gap-x-2" data-glance-certification={entry.verdict}>
                  <span>{entry.name}</span>
                  {entry.verdict === 'meets' && (
                    <span className="inline-flex items-center gap-1 text-[13px] font-medium text-success-ink">
                      <CheckCircleIcon size={14} weight="fill" aria-hidden="true" className="text-success" />
                      {t('LABEL_JOB_GLANCE_HAVE_IT')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </GlanceRow>
        )}
        {sponsorsH1b === true && (
          <GlanceRow row="h1b" icon={<IdentificationCardIcon />} label="H1B">
            Sponsors H1B
          </GlanceRow>
        )}
        {requiresClearance === true && (
          <GlanceRow row="clearance" icon={<ShieldCheckIcon />} label="Security clearance">
            {CLEARANCE_FILTER_LABEL.required}
          </GlanceRow>
        )}
      </dl>
    );
  }

  return (
    <DetailCard id="job-glance" title={t('LABEL_JOB_GLANCE')} tip={t('MSG_JOB_GLANCE_TIP')} data-glance-card="">
      {body}
    </DetailCard>
  );
}
