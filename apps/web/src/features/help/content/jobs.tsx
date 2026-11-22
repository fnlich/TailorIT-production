'use client';

import { JOB_REPORT_REASON_LABEL, JOB_REPORT_REASONS, JOB_SORTS, JOB_SORT_LABEL } from '@tailorit/shared';
import { BriefcaseIcon } from '@/components/ui/icons';
import { useGuide } from '../context';
import type { GuideSection } from '../model';
import { AppPage, Bullets, P, See, Steps, Ui } from '../parts';
import { FANOUT_COPY } from '../../sharing/fanout/copy';

// v34 HELP: Find jobs: the search, a job's details, and saving, applying and adding a job.

function Search() {
  const { t, get } = useGuide();
  return (
    <>
      <P>
        <AppPage href="/jobs">Jobs</AppPage> lists the postings TailorIT has read (newest first until you type words, then the best matches first), each with your match: how
        many of the posting&apos;s keywords your resume already has, drawn as a small tape meter.
      </P>
      <Bullets>
        <li>
          <Ui>{t('LABEL_JOBS_MODE_KEYWORDS')}</Ui> searches the words you type (titles, companies, skills).{' '}
          <Ui>{t('LABEL_JOBS_MODE_AI')}</Ui> turns a sentence into filters with TailorIT&apos;s AI; it is part of the Paid
          plan and counts toward your AI use.
        </li>
        <li>
          <Ui>Filters</Ui>: job type, experience level, category, leadership (when the jobs have it), work arrangement, place or &quot;Remote in&quot;, minimum
          salary, visa sponsorship, industry, company size, company, clearance, last updated and hide applied. The filters in
          use show as chips you can remove; on a phone they are behind <Ui>All filters</Ui>. The category picker has a{' '}
          <Ui>{t('LABEL_JOBS_MY_FIELD')}</Ui> chip: your field&apos;s categories in one click.
        </li>
        <li>
          <Ui>Jobs I can apply to</Ui> (off by default) hides jobs whose location rules leave out where you live, as
          Settings › Job preferences and your time zone say. A rule TailorIT cannot read is not held against a job.
        </li>
        <li>
          <Ui>Sort</Ui>: {JOB_SORTS.map((sort) => JOB_SORT_LABEL[sort]).join(', ')}.
        </li>
        <li>
          <Ui>Saved searches</Ui> keep a search and its filters to run again (you can keep {get('SAVED_SEARCHES_MAX')}).
        </li>
      </Bullets>
      <P>
        From a wide window the list and the job sit side by side, and the first job opens as the list loads; on a phone a
        job opens full screen with Back. Previous and Next walk the list, and the address keeps the job you opened.
      </P>
    </>
  );
}

function Details() {
  const { t } = useGuide();
  return (
    <>
      <P>A job&apos;s details show what you need to decide at once:</P>
      <Bullets>
        <li>
          <Ui>The header</Ui>: the company and the title, the category, when TailorIT last found the posting live, when it
          was posted, and pills for the job type, the place, the pay and the work mode.
        </li>
        <li>
          <Ui>{t('LABEL_JOB_ABOUT_ROLE')}</Ui>: a <Ui>{t('LABEL_JOB_SUMMARY')}</Ui> or the <Ui>{t('LABEL_JOB_FULL_POSTING')}</Ui>, then the
          company.
        </li>
        <li>
          <Ui>{t('LABEL_JOB_GLANCE')}</Ui>: the experience, education, and licences and certifications the posting asks for,
          each checked against your profile (a check, a &quot;below&quot; mark, or unknown when the posting or your profile
          does not say), and whether the company sponsors visas or the job needs a security clearance.
        </li>
        <li>
          <Ui>{t('LABEL_JOB_SKILLS')}</Ui>: the posting&apos;s skills, the ones your resume has highlighted and the missing
          ones outlined, with the resume they were scored against.
        </li>
        <li>
          <Ui>{t('LABEL_JOB_DETAIL_TAILOR')}</Ui> makes a resume for this job with TailorIT&apos;s AI (see{' '}
          <See to="docs-tailor">Tailoring a resume</See>), and <Ui>{t('LABEL_JOB_BENEFITS')}</Ui> lists what the posting
          offers.
        </li>
      </Bullets>
      <P>
        A job someone added that an admin published shows <Ui>{t('LABEL_JOB_APPROVED_BY_ADMIN')}</Ui>. The company&apos;s
        name opens its page, with its other jobs.
      </P>
    </>
  );
}

function SaveAndApply() {
  const { t, get } = useGuide();
  return (
    <>
      <Bullets>
        <li>
          <Ui>Save</Ui> puts the job in your Job Tracker as Saved, with the resume that matches it best.
        </li>
        <li>
          <Ui>Save all</Ui> saves the jobs your search matches, in the order the list shows them ({get('SAVE_BATCH_MAX')} a
          click); <Ui>Undo</Ui> takes them back out. You can also select jobs and save the selection.
        </li>
        <li>
          <Ui>Apply</Ui> opens the posting&apos;s application page; <Ui>{t('LABEL_JOB_MARK_APPLIED')}</Ui> records that you
          applied, so the Job Tracker moves the job to Applied.
        </li>
      </Bullets>
      <P>
        <Ui>Add job</Ui> takes a posting&apos;s link: TailorIT reads the posting itself and tells you what came of it. A
        link it cannot read makes a job only you see, marked <Ui>{t('LABEL_JOB_FROM_BROWSER')}</Ui>, with Retry read. You can
        add {get('JOB_ADDS_PER_HOUR')} links an hour.
      </P>
      <P>
        Working on several profiles? Save&apos;s arrow, <Ui>{FANOUT_COPY.saveTo}</Ui>, saves the job on other profiles too,
        and a job shows which other profiles have it saved: see <See to="sharing-all">Every profile at once</See>.
      </P>
    </>
  );
}

function Report() {
  const reasons = JOB_REPORT_REASONS.map((reason) => JOB_REPORT_REASON_LABEL[reason]);
  return (
    <Steps>
      <li>
        Open the job and choose the flag, <Ui>Report this job</Ui>.
      </li>
      <li>
        Choose what is wrong ({reasons.join('; ')}) and add anything that helps. TailorIT checks a job reported closed
        before it leaves the search; an admin reviews the rest. The company&apos;s card has its own report for wrong company
        details.
      </li>
    </Steps>
  );
}

export const JOBS_SECTION: GuideSection = {
  id: 'find-jobs',
  title: 'Find jobs',
  icon: BriefcaseIcon,
  keywords: ['search', 'filter', 'jobs', 'posting'],
  topics: [
    { id: 'jobs-search', title: 'Search and filters', keywords: ['ask ai', 'sort', 'saved search', 'my field'], Body: Search },
    { id: 'jobs-details', title: "A job's details", keywords: ['requirements', 'skills', 'match', 'benefits'], Body: Details },
    { id: 'jobs-save', title: 'Save, apply and add a job', keywords: ['save all', 'mark as applied', 'add job', 'link'], Body: SaveAndApply },
    { id: 'jobs-report', title: 'Report a job', keywords: ['closed', 'scam', 'wrong'], Body: Report },
  ],
};
