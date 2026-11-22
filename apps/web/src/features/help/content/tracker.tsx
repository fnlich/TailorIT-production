'use client';

import { APPLICATION_STATUSES, RESUME_ZIP_MAX_APPLICATIONS, STATUS_INFO } from '@tailorit/shared/tracker';
import { KanbanIcon } from '@/components/ui/icons';
import { useGuide } from '../context';
import type { GuideSection } from '../model';
import { AppPage, Bullets, P, See, Ui } from '../parts';
import { FANOUT_COPY } from '../../sharing/fanout/copy';

// v34 HELP: the Job Tracker: its views, an application's details, its actions, and the All profiles view.

function Views() {
  const { t } = useGuide();
  const statuses = APPLICATION_STATUSES.map((code) => STATUS_INFO[code].label);
  return (
    <>
      <P>
        The <AppPage href="/tracker">Job Tracker</AppPage> keeps every job you saved or applied to, by stage:{' '}
        {statuses.join(', ')}. Archived applications are kept apart (<Ui>Active</Ui> | <Ui>Archived</Ui>).
      </P>
      <Bullets>
        <li>
          <Ui>Board</Ui>: a lane per stage; each card shows its next step and how long it has been in its stage. Drag a card
          to another lane, or use its menu&apos;s <Ui>{t('LABEL_TRACKER_MOVE_TO_STAGE')}</Ui>. On a phone the board shows
          one lane at a time, with a row of the lanes and their counts above it.
        </li>
        <li>
          <Ui>List</Ui>: a table, with each application&apos;s stage drawn as a meter.
        </li>
        <li>
          <Ui>Chart</Ui>: how your applications flowed from stage to stage, and what that says.
        </li>
      </Bullets>
      <P>
        A saved job whose kit is waiting in the auto-apply queue stays in Saved with a <Ui>{t('STATUS_DRAFT_LABEL')}</Ui>{' '}
        mark. Which lanes show is up to you: the ⋮ menu&apos;s <Ui>{t('LABEL_TRACKER_LANES')}</Ui>, kept for your account on
        every browser.
      </P>
    </>
  );
}

function Detail() {
  return (
    <>
      <P>Open an application to see everything about it in one place:</P>
      <Bullets>
        <li>the posting, your notes and the status timeline (each stage with its day);</li>
        <li>
          its documents and your match. Each saved job gets its <Ui>best-matched resume</Ui> (&quot;Best match&quot;) until
          you pick one (&quot;Chosen by you&quot;); the picker ranks your resumes by fit, and <Ui>Let TailorIT choose</Ui>{' '}
          goes back;
        </li>
        <li>the questions the job&apos;s form asks, when TailorIT knows them;</li>
        <li>
          <Ui>Prepared</Ui>: the resume, cover letter and answers Prepare &amp; Queue made, with any answer not ready yet
          marked, and once applied, what it was sent with;
        </li>
        <li>
          the <Ui>submitted answers</Ui>: the form&apos;s questions and what was sent, kept when the TailorIT extension
          submits an application.
        </li>
      </Bullets>
    </>
  );
}

function Actions() {
  const { t } = useGuide();
  return (
    <Bullets>
      <li>
        <Ui>{t('LABEL_TRACKER_FILTER')}</Ui>: filters, favorites and the order of the cards.
      </li>
      <li>
        <Ui>{t('LABEL_TRACKER_SELECT')}</Ui>: pick applications, then archive, restore or delete them, move them to a stage,
        or build their resumes as a zip. The ⋮ menu&apos;s <Ui>Prepare &amp; Queue jobs</Ui> picks saved jobs to prepare.
      </li>
      <li>
        <Ui>Add application</Ui>: paste the posting&apos;s link first; TailorIT fills in the title and company from it. You
        type the details only when there is no link or TailorIT cannot read it.
      </li>
      <li>
        <Ui>{t('LABEL_TRACKER_IMPORT')}</Ui> and <Ui>{t('LABEL_TRACKER_EXPORT')}</Ui> move your applications in and out as a
        spreadsheet file.
      </li>
      <li>
        <Ui>Build resumes (zip)</Ui> downloads the resume of each saved application (or of the selected ones) in folders by
        company and role. It is part of the Paid plan; one zip holds {RESUME_ZIP_MAX_APPLICATIONS.toLocaleString('en-US')}{' '}
        resumes, and without a selection it takes the first ones in the Job Tracker&apos;s order.
      </li>
      <li>
        <Ui>Archive all applications</Ui> clears the board in one step; archived ones stay under Archived.
      </li>
    </Bullets>
  );
}

function AllProfiles() {
  const { t } = useGuide();
  return (
    <>
      <P>
        Once someone shares their Job Tracker with you, the Job Tracker offers <Ui>All profiles</Ui>: your applications and
        every shared profile&apos;s in one board or list, each card marked with whose it is. Each card&apos;s actions work on
        its own profile.
      </P>
      <P>
        <Ui>{t('LABEL_TRACKER_SELECT')}</Ui> › <Ui>{FANOUT_COPY.copyTo}</Ui> saves the selected applications&apos; jobs on
        other profiles (as Saved; notes, history and documents stay where they are). The All profiles view has{' '}
        <Ui>{t('LABEL_TRACKER_SELECT')}</Ui> too: copy cards of several profiles, move them to a stage, archive or restore them
        (with Undo), each on the card&apos;s own profile (a move, archive or restore leaves a card whose profile is shared
        to see only alone, and names it). Its <Ui>Prepare &amp; Queue jobs</Ui> takes the saved jobs of each profile you may prepare, after one
        question, and <Ui>Prepare all profiles</Ui> prepares every profile&apos;s saved jobs in one go. See{' '}
        <See to="sharing-all">Every profile at once</See>.
      </P>
    </>
  );
}

export const TRACKER_SECTION: GuideSection = {
  id: 'job-tracker',
  title: 'Job Tracker',
  icon: KanbanIcon,
  keywords: ['tracker', 'applications', 'board', 'status'],
  topics: [
    { id: 'tracker-views', title: 'Board, list and chart', keywords: ['lanes', 'stage', 'draft'], Body: Views },
    { id: 'tracker-detail', title: "An application's details", keywords: ['notes', 'timeline', 'best match', 'prepared'], Body: Detail },
    { id: 'tracker-actions', title: 'Select, import and export', keywords: ['csv', 'zip', 'archive', 'add application'], Body: Actions },
    { id: 'tracker-all-profiles', title: 'All profiles', keywords: ['shared', 'copy'], Body: AllProfiles },
  ],
};
