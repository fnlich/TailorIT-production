'use client';

import { JOB_REPORT_REASON_LABEL, JOB_REPORT_REASONS, JOB_SORTS, JOB_SORT_LABEL, UPDATED_WITHIN_DAYS, UPDATED_WITHIN_LABEL } from '@tailorit/shared';
import {
  JOB_IMPORT_DOWNLOAD_COLUMNS,
  JOB_IMPORT_MAX_COLUMNS,
  JOB_IMPORT_NOTICE_MIN_ROWS,
  JOB_IMPORT_ROW_RESULT_LABEL,
  SHEET_SOURCE_LABEL,
} from '@tailorit/shared/ingest';
import { BriefcaseIcon } from '@/components/ui/icons';
import { useGuide } from '../context';
import type { GuideSection } from '../model';
import { AppPage, Bullets, P, See, Steps, Ui } from '../parts';
import { FANOUT_COPY } from '../../sharing/fanout/copy';
import { SELECTION_COPY } from '../../jobs/list/selectionCopy'; // v36 JOBS

// v34 HELP: Find jobs: the search, a job's details, and saving, applying and adding a job. v35 OPSWEB (PLAN H5, H8): the
// date filter's Past 3 days and reposted jobs; adding jobs by one link with details, a file or a Google Sheet, what each
// row's result means, Download these rows, and the limits (public constants).

/**
 * v36 FIX-SRC (the final reviews' data D7 = ux L9): "7 days", "1 day": when an admin's import reads "Reposted" is the
 * admin's value of ADMIN_IMPORT_REPOSTED_AFTER_DAYS (a public constant now), never a fixed "a week".
 */
const daysText = (days: number) => `${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'}`;

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
          <Ui>Last updated</Ui>: {UPDATED_WITHIN_DAYS.map((days) => UPDATED_WITHIN_LABEL[days]).join(', ')}. A job TailorIT&apos;s
          admin imports, new to TailorIT or imported again, counts as new from that day: it shows under these filters and near the top of{' '}
          <Ui>{JOB_SORT_LABEL.posted}</Ui>, as posted at the import. Its row and its header say &quot;Reposted&quot; when its
          board posted it more than {daysText(get('ADMIN_IMPORT_REPOSTED_AFTER_DAYS'))} before, else &quot;Posted&quot;.
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
          was posted (and reposted, when it was), and pills for the job type, the place, the pay and the work mode.
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
        When an admin publishes a job you added that TailorIT could not read, you are told in your notifications; only
        admins see such a job marked <Ui>{t('LABEL_JOB_APPROVED_BY_ADMIN')}</Ui>. The company&apos;s name opens its page,
        with its other jobs.
      </P>
    </>
  );
}

function SaveAndApply() {
  const { t } = useGuide();
  return (
    <>
      <Bullets>
        <li>
          <Ui>Save</Ui> puts the job in your Job Tracker as Saved, with the resume that matches it best.
        </li>
        <li>
          <Ui>Select</Ui> (the checklist button above the list) lets you tick jobs, saved ones too, then{' '}
          <Ui>{SELECTION_COPY.save}</Ui> puts them in your saved jobs (a job saved already is counted, not saved twice) and{' '}
          <Ui>{SELECTION_COPY.unsave}</Ui> takes them out (a job you applied to stays as it is; one waiting in the auto-apply
          queue leaves it too, unless it is being applied now). Either one says what it did,
          with <Ui>Undo</Ui>; <Ui>{SELECTION_COPY.done}</Ui> ends the selection.
        </li>
        <li>
          <Ui>Apply</Ui> opens the posting&apos;s application page; <Ui>{t('LABEL_JOB_MARK_APPLIED')}</Ui> records that you
          applied, so the Job Tracker moves the job to Applied.
        </li>
      </Bullets>
      <AddJob />
      <P>
        Working on several profiles? Save&apos;s arrow, <Ui>{FANOUT_COPY.saveTo}</Ui>, saves the job on other profiles too;
        the Select bar&apos;s <Ui>{SELECTION_COPY.save}</Ui> and <Ui>{SELECTION_COPY.unsave}</Ui> have arrows that pick the
        profiles; and a job shows which other profiles have it saved: see <See to="sharing-all">Every profile at once</See>.
      </P>
    </>
  );
}

/** "100" or "no limit" (a limit constant of null). */
const perDay = (value: number | null) => (value === null ? 'no limit' : value.toLocaleString('en-US'));

/** v35 OPSWEB: Add job's three ways, what each row comes to, and the limits. */
function AddJob() {
  const { t, get } = useGuide();
  // The tab's name as Add job shows it (SHEET_SOURCE_LABEL), and the columns of a file to fill in (Download these rows').
  const sheet = SHEET_SOURCE_LABEL;
  const columns = JOB_IMPORT_DOWNLOAD_COLUMNS;
  return (
    <>
      <P>
        <Ui>Add job</Ui> adds jobs three ways: <Ui>One link</Ui>, a <Ui>File</Ui> or a <Ui>{sheet}</Ui>. TailorIT reads
        each posting itself and tells you what came of it.
      </P>
      <Bullets>
        <li>
          <Ui>One link</Ui>: paste a posting&apos;s link. <Ui>Add details</Ui> (optional) takes its company, title, description,
          rate and location: TailorIT uses them only when it cannot read the link, and the rate only when the posting names no
          pay. A link it cannot read makes a job only you see, marked <Ui>{t('LABEL_JOB_FROM_BROWSER')}</Ui>, with Retry read
          (a Retry read that finds the posting closed marks that job closed). When the site has asked TailorIT to slow down (Workday
          sites often do), Add job says when to try again and keeps nothing. You can add {get('JOB_ADDS_PER_HOUR')} links an
          hour.
        </li>
        <li>
          <Ui>File</Ui> (.csv, .tsv, .txt, .json or .xlsx) or <Ui>{sheet}</Ui> (share it with TailorIT&apos;s reader address
          as a Viewer): one job a row, in the columns {columns.join(', ')}. Only the link is needed. TailorIT guesses each
          column from the header and shows the first rows, so you can change any before you import. With no header row, a
          column of pay is read as the Rate.
        </li>
        <li>
          <Ui>Limits</Ui>: up to {get('JOB_IMPORT_ROWS_MAX').toLocaleString('en-US')} rows and {JOB_IMPORT_MAX_COLUMNS} columns a
          file or sheet, and{' '}
          {perDay(get('FREE_JOB_IMPORT_ROWS_PER_DAY'))} rows a day on Free ({perDay(get('PAID_JOB_IMPORT_ROWS_PER_DAY'))} on
          Paid). Add job says how many more you can import today, and before you import, how many of a file&apos;s rows
          fit. Rows past that are not imported: import the same file again a day later, and the rows already added are
          skipped (they come back <Ui>{JOB_IMPORT_ROW_RESULT_LABEL.known}</Ui>).
        </li>
      </Bullets>
      <P>What each row of a file or sheet comes to:</P>
      <Bullets>
        <li>
          <Ui>{JOB_IMPORT_ROW_RESULT_LABEL.added}</Ui>: TailorIT read the posting, and the job is in your Job Tracker as Saved.{' '}
          <Ui>{JOB_IMPORT_ROW_RESULT_LABEL.known}</Ui>: the job was there already; it is saved to your Job Tracker too.
        </li>
        <li>
          <Ui>{JOB_IMPORT_ROW_RESULT_LABEL.added_private}</Ui>: TailorIT could not read the link, so your own job was made from
          the row&apos;s title and company; an admin reviews it before others can find it.
        </li>
        <li>
          <Ui>{JOB_IMPORT_ROW_RESULT_LABEL.needs_details}</Ui>: TailorIT could not read the link and the row has no title or
          company, so nothing was kept. <Ui>Download these rows</Ui> saves them as a CSV file: fill them in and import it again.
        </li>
        <li>
          <Ui>{JOB_IMPORT_ROW_RESULT_LABEL.queued}</Ui>: the posting&apos;s site failed for now or asked TailorIT to slow down.
          TailorIT reads the link again later, for up to {get('LINK_QUEUE_RETRY_HOURS')} hours, before the row comes to its
          result; the row says why and when it is read next.
        </li>
        <li>
          <Ui>{JOB_IMPORT_ROW_RESULT_LABEL.closed}</Ui>: the posting has closed. <Ui>{JOB_IMPORT_ROW_RESULT_LABEL.failed}</Ui>: not a
          job link TailorIT may read (a site it never reads, a row over the day&apos;s limit), with why.{' '}
          <Ui>{JOB_IMPORT_ROW_RESULT_LABEL.repeated}</Ui>: the same link as a row above it.
        </li>
      </Bullets>
      <P>
        Closing Add job does not stop an import: the bell says when one of more than {JOB_IMPORT_NOTICE_MIN_ROWS} rows
        finishes, and Add job shows your latest import&apos;s results again. On a profile someone shared with you, the jobs
        are saved to that profile.
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
        before it leaves the search; an admin reviews the rest. A report on a job that closes meanwhile is settled with it.
        The company&apos;s card has its own report for wrong company details.
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
    { id: 'jobs-search', title: 'Search and filters', keywords: ['ask ai', 'sort', 'saved search', 'my field', 'past 3 days', 'reposted'], Body: Search },
    { id: 'jobs-details', title: "A job's details", keywords: ['requirements', 'skills', 'match', 'benefits'], Body: Details },
    {
      id: 'jobs-save',
      title: 'Save, apply and add a job',
      // v35 OPSWEB: importing a file or a sheet.
      keywords: ['select', 'unsave', 'mark as applied', 'add job', 'link', 'import', 'csv', 'xlsx', 'google sheet', 'download these rows'],
      Body: SaveAndApply,
    },
    { id: 'jobs-report', title: 'Report a job', keywords: ['closed', 'scam', 'wrong'], Body: Report },
  ],
};
