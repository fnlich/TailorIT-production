'use client';

import { RobotIcon } from '@/components/ui/icons';
import { agentSitesText, queueSitesText, SAVED_FILTER_LABEL } from '../../auto-apply/copy';
import { PREPARE_ON, SAVED_SELECT, SAVED_SELECT_MAX } from '../../prepare/copy';
import { FANOUT_COPY } from '../../sharing/fanout/copy';
import { SELECTION_COPY } from '../../jobs/list/selectionCopy'; // v36 FIX-WEB (D1)
import { useBoxName } from '../boxes';
import { FILTERS_COPY, LETTER_MODE_LABEL, PREPARE_COPY } from '../../settings/prepare/copy';
import { useGuide } from '../context';
import type { GuideSection } from '../model';
import { AppPage, Bullets, P, See, Steps, Ui } from '../parts';

// v34 HELP: Auto-apply: how a saved job becomes an application, the kit, the queue's states, Prepare filters and
// Prepare All, the Auto-save rule, and the Prepare settings.
// v36 APPLYWEB (PLAN A1-A6): the page fits the window, Prepare All on other profiles, Share All, Select and its bar,
// a row's Share to; the action is named "Prepare" (it was two words).

function HowItWorks() {
  const { t } = useGuide();
  return (
    <>
      <P>
        A job reaches the auto-apply queue one way only: you save it, then you prepare it. The{' '}
        <AppPage href="/auto-apply">Auto-apply</AppPage> page has two panes, <Ui>Saved jobs</Ui> (your Job Tracker&apos;s
        Saved entries) and <Ui>Queue</Ui>; on a narrow screen they are tabs. On a wide screen the page fits the window and
        each pane scrolls on its own.
      </P>
      <Steps>
        <li>
          <Ui>Save</Ui> jobs: from Jobs, the extension, your own AI, or the <Ui>Auto-save new jobs</Ui> rule.
        </li>
        <li>
          <Ui>Prepare</Ui> a saved job, a selection, or all of them with <Ui>Prepare All</Ui>. TailorIT makes
          each job&apos;s <Ui>kit</Ui> in the background while the job shows <Ui>{t('STATE_PREPARING')}</Ui>.
        </li>
        <li>
          When the kit is complete the job is queued by itself and shows <Ui>{t('STATE_READY')}</Ui>.
        </li>
        <li>
          The TailorIT browser extension takes the ready jobs and applies (see <See to="extension">The browser extension</See>
          ). An applied job leaves Saved jobs and becomes Applied in the Job Tracker.
        </li>
      </Steps>
      <P>
        Prepare asks before it uses TailorIT&apos;s AI, every time, until you tick{' '}
        <Ui>{t('MSG_PREPARE_CONFIRM_DONT_SHOW')}</Ui> or turn the question off in Settings. <Ui>How auto-apply works</Ui>, at
        the top of the page, sums this up.
      </P>
      {/* v34 FIX-COPY (final review share M1, as FIX-API and FIX-WEB build it): the payer's own setting decides. */}
      <P>
        On a profile someone shared with you, your own <Ui>{PREPARE_COPY.askTitle}</Ui> decides whether you are asked, as you
        pay for the AI; it is never copied to other profiles, and only each profile&apos;s owner changes theirs.
      </P>
    </>
  );
}

function Kit() {
  const { t } = useGuide();
  return (
    <>
      <P>A job&apos;s kit is what its application sends:</P>
      <Bullets>
        <li>
          <Ui>the resume</Ui>: your default resume, your best-matched one, or one tailored for the job, as your resume setting
          says (see <See to="auto-settings">Prepare settings</See>);
        </li>
        <li>
          <Ui>a cover letter</Ui>, when one is wanted;
        </li>
        <li>
          <Ui>answers</Ui> to the questions TailorIT knows the job&apos;s form asks. A question it does not know yet is
          answered by the extension during the application.
        </li>
      </Bullets>
      <P>
        The letter and every answer are written from the resume the application uses, so they agree with it.
        Self-identification, legal, pay, consent, attention-check and personal-detail questions, links and file fields are
        never prepared and never sent to AI: your Autofill profile and the extension fill them when you apply. Once a job is queued its kit is fixed; preparing it again makes a new kit. A kit made earlier and
        still ready is queued at once, with no AI.
      </P>
      <P>
        Who writes the kit: <Ui>TailorIT&apos;s AI</Ui>, in the background, counted toward your AI use (on a Free account,
        Prepares beyond the hourly number wait their turn), or <Ui>your own AI</Ui> through MCP, which you start from your AI app and which
        never uses TailorIT&apos;s AI (the job then shows <Ui>{t('STATE_PREPARING_OWN_AI')}</Ui>; see{' '}
        <See to="mcp-prepare">Prepare with your AI</See>).
      </P>
    </>
  );
}

function Queue() {
  const { t } = useGuide();
  const states: Array<[string, string]> = [
    [t('STATE_READY'), 'the kit is complete; the extension will take it.'],
    [t('STATE_APPLYING'), 'the extension is applying right now.'],
    [t('STATE_APPLIED'), 'sent; the Job Tracker has it as Applied.'],
    [t('STATE_NEEDS_YOU'), 'something only you can do stopped it (a CAPTCHA, a code sent to your email, a sign-in); the row says what, with Try again.'],
    [t('STATE_FAILED'), 'it did not go through; the row gives the reason and Try again.'],
    [t('STATE_WAITING_RESET'), "today's auto-applies are used up on your plan; it goes when the day starts again."],
    [t('STATE_MANUAL'), 'the extension cannot fill this site; you apply yourself.'],
    [t('STATE_PREPARE_FAILED'), 'a required part (the resume, a wanted letter) could not be made; the reason and Try again are on the row.'],
    [t('STATE_PREPARED'), 'the kit is made but your queue was full; Prepare puts it in line once there is room.'],
  ];
  return (
    <>
      <Bullets>
        {states.map(([state, meaning]) => (
          <li key={state}>
            <Ui>{state}</Ui>: {meaning}
          </li>
        ))}
      </Bullets>
      <P>
        <Ui>{t('STATE_MANUAL')}</Ui>: open the job&apos;s page, download the prepared resume, copy or download the letter,
        copy each answer, apply, then choose <Ui>{t('LABEL_JOB_MARK_APPLIED')}</Ui>. Applying by hand never counts toward a
        daily limit. Cancel stops a Prepare at once; Remove takes a job out of the queue.
      </P>
      <P>
        Removing a saved job (the Saved pane&apos;s <Ui>{SAVED_SELECT.remove}</Ui>, Jobs&apos; <Ui>{SELECTION_COPY.unsave}</Ui>, or
        archiving it in the Job Tracker) also removes it from the queue while it waits there, and the result says so. A job
        the extension is applying to right now stays in saved jobs and in the queue, and so does a queued job on a profile
        shared with you without its <Ui>{t('LABEL_SHARING_ROW_QUEUE')}</Ui> box. <Ui>{FANOUT_COPY.undo}</Ui> brings the saved job
        back but not its place in the queue: prepare it again to queue it.
      </P>
      <P>
        A job someone prepared on your profile waits for your OK unless you let them apply without it: Auto-apply then shows
        who it is from, with <Ui>Approve all</Ui> and <Ui>Remove</Ui> (see <See to="sharing-work">Working on a shared profile</See>
        ).
      </P>
    </>
  );
}

function FiltersAndPrepareAll() {
  const { get } = useGuide();
  const names = [
    FILTERS_COPY.locationType,
    FILTERS_COPY.jobType,
    FILTERS_COPY.industry,
    FILTERS_COPY.locationMismatch,
    FILTERS_COPY.qualifications,
    FILTERS_COPY.certifications,
    FILTERS_COPY.autoApply,
    FILTERS_COPY.minPay,
    FILTERS_COPY.experience,
    FILTERS_COPY.sponsorship,
    FILTERS_COPY.clearance,
    FILTERS_COPY.custom,
  ];
  return (
    <>
      <P>
        <Ui>Prepare filters</Ui> decide which saved jobs may be prepared: {names.join(', ')}. A job that fails one is
        labelled with the reason and stays in Saved jobs; a detail the posting does not state never filters a job out.{' '}
        <Ui>{FILTERS_COPY.custom}</Ui> is your own words, which TailorIT&apos;s AI judges each job against (using your AI use),
        or your own AI through MCP.
      </P>
      <Bullets>
        <li>
          <Ui>Filters</Ui> (the funnel on the Saved pane, with how many are on) opens your filters with a live count of the
          saved jobs that pass: <Ui>Only Filter</Ui> saves them, <Ui>Filter and Prepare</Ui> saves them and runs Prepare All.
          The same filters are in Settings › Prepare.
        </li>
        <li>
          <Ui>Prepare All</Ui> prepares every saved job in <Ui>{SAVED_FILTER_LABEL.ready}</Ui> that passes your filters. It
          always asks first, with the count and today&apos;s AI use, and takes {get('PREPARE_BATCH_MAX')} jobs at a time and
          what fits in your queue ({get('QUEUE_SIZE_MAX')} places), saying what it leaves for the next press.
        </li>
        <li>
          The Saved pane&apos;s tabs: <Ui>{SAVED_FILTER_LABEL.all}</Ui>, <Ui>{SAVED_FILTER_LABEL.ready}</Ui>,{' '}
          <Ui>{SAVED_FILTER_LABEL.filtered}</Ui> and the drafts in the queue. <Ui>Select</Ui> picks jobs by hand (see{' '}
          <See to="auto-select">Select, Share and other profiles</See>).
        </li>
        <li>
          <Ui>Auto-save new jobs</Ui> (under the Saved pane, off by default) saves new jobs that match you well enough. It
          never prepares or queues anything, so it never uses AI. A new job is one TailorIT first found after you turned
          the rule on: a job that waited for an admin&apos;s approval, or one an admin imported again that TailorIT already
          knew, is not picked.
        </li>
      </Bullets>
      <P>
        With shared profiles, the Filters dialog&apos;s <Ui>Apply to</Ui> sends what you change to other profiles too, and
        the Auto-save rule can be copied to them: see <See to="sharing-all">Every profile at once</See>.
      </P>
    </>
  );
}

// v36 APPLYWEB (PLAN A2-A5): the Saved pane's Select bar, Share All, Prepare All on other profiles and a row's Share to.
function SelectAndShare() {
  const { get } = useGuide();
  const boxName = useBoxName();
  return (
    <>
      <P>
        <Ui>Select</Ui> (the checklist icon on the Saved pane) lets you tick any saved job. Its bar has:
      </P>
      <Bullets>
        <li>
          <Ui>Select All</Ui>, then <Ui>Deselect All</Ui>: every saved job in the tab you are on, up to {SAVED_SELECT_MAX}{' '}
          (the ones not shown yet are read first).
        </li>
        <li>
          <Ui>{SAVED_SELECT.remove}</Ui> (the archive icon): the ticked jobs leave saved jobs after one question, archived in
          your Job Tracker, and leave the auto-apply queue if they wait there (the question says how many);{' '}
          <Ui>{FANOUT_COPY.undo}</Ui> brings them back to saved jobs. A job applied to meanwhile, or being applied now, stays
          as it is.
        </li>
        <li>
          <Ui>{FANOUT_COPY.share}</Ui> and its arrow: share the ticked jobs with other profiles (below).
        </li>
        <li>
          <Ui>Prepare</Ui> and its arrow: prepare the ticked jobs that can be prepared (the others are counted as skipped),
          on the profile you are on, or on other profiles: there each job it lacks is saved first, then prepared with that
          profile&apos;s filters and settings, after one question (&quot;{PREPARE_ON.savesAndPrepares(2, 'Ana')}&quot;). A
          profile needs both <Ui>{boxName('tracker:edit')}</Ui> and <Ui>{boxName('prepare:run')}</Ui> for that.
        </li>
        <li>
          <Ui>{SAVED_SELECT.cancel}</Ui> ends the selection.
        </li>
      </Bullets>
      <P>
        Once someone has shared their profile with you, <Ui>Prepare All</Ui> has an arrow too: this profile, each other
        profile, <Ui>{FANOUT_COPY.allProfiles}</Ui> and <Ui>{FANOUT_COPY.chooseProfiles}</Ui>. Each profile prepares its own
        saved jobs, with its owner&apos;s filters and settings, yours first, after one question that gives each
        profile&apos;s count; your AI use pays for all of it.
      </P>
      <P>
        <Ui>{FANOUT_COPY.shareAll}</Ui> shares every job in Saved on the profile you are on with the profiles you choose. Its
        question says, for each profile, how many jobs will be added, are already there, or come back to Saved there (a job
        its owner had removed from Saved); it takes the newest {get('SHARE_ALL_MAX')} at a time. Each saved job&apos;s ⋯
        menu has <Ui>{FANOUT_COPY.shareTo} ›</Ui> for that job alone: a profile that has it already is ticked and off.
      </P>
      <P>
        Sharing goes to the profiles shared with you whose <Ui>{boxName('tracker:edit')}</Ui> box is ticked, and to your own
        profile while you work on a shared one; never to the profile you are on. Only the jobs go, as Saved: notes, history,
        documents, kits and the queue stay where they are, and each profile picks its own resume. The result says what
        happened on each profile, with <Ui>{FANOUT_COPY.undo}</Ui>. On a profile shared with you without its{' '}
        <Ui>{boxName('tracker:view')}</Ui> box, nothing can be shared from it, and Share says so.
      </P>
    </>
  );
}

function PrepareSettings() {
  const { t } = useGuide();
  return (
    <>
      <P>
        <AppPage href="/settings#prepare">Settings › Prepare</AppPage>:
      </P>
      <Bullets>
        <li>
          <Ui>{PREPARE_COPY.resume}</Ui>: <Ui>{t('LABEL_RESUME_MODE_DEFAULT')}</Ui> (as it is, no AI),{' '}
          <Ui>{t('LABEL_RESUME_MODE_SIMILAR')}</Ui> (the existing resume that fits the job best, chosen without AI) or{' '}
          <Ui>{t('LABEL_RESUME_MODE_TAILOR')}</Ui> (a new resume tailored for each job, which counts toward your resumes).
        </li>
        <li>
          <Ui>{PREPARE_COPY.letters}</Ui>: <Ui>{LETTER_MODE_LABEL.required}</Ui> (the form or the posting asks for one) or{' '}
          <Ui>{LETTER_MODE_LABEL.always}</Ui>.
        </li>
        <li>
          <Ui>{PREPARE_COPY.askTitle}</Ui>: the question before Prepare uses AI, on or off.
        </li>
        <li>
          <Ui>{FILTERS_COPY.title}</Ui>: as above.
        </li>
      </Bullets>
    </>
  );
}

function ExtensionSites() {
  return (
    <P>
      The extension&apos;s <Ui>Run auto-apply</Ui> applies in the background on {agentSitesText()}; its <Ui>Queue tab</Ui>{' '}
      also opens jobs on {queueSitesText()} in tabs you watch.
    </P>
  );
}

export const AUTO_APPLY_SECTION: GuideSection = {
  id: 'auto-apply',
  title: 'Auto-apply',
  icon: RobotIcon,
  keywords: ['prepare', 'queue', 'kit', 'apply'],
  topics: [
    { id: 'auto-steps', title: 'How auto-apply works', keywords: ['save', 'prepare'], Body: HowItWorks },
    { id: 'auto-kit', title: "A job's kit", keywords: ['resume', 'letter', 'answers'], Body: Kit },
    { id: 'auto-queue', title: 'The queue', keywords: ['ready', 'needs you', 'failed', 'apply manually', 'states'], Body: Queue },
    { id: 'auto-sites', title: 'Sites the extension applies on', keywords: ['greenhouse', 'lever', 'workday', 'platforms'], Body: ExtensionSites },
    { id: 'auto-filters', title: 'Prepare filters and Prepare All', keywords: ['filter', 'custom', 'auto-save', 'sponsorship', 'visa', 'clearance'], Body: FiltersAndPrepareAll },
    // v36 APPLYWEB
    { id: 'auto-select', title: 'Select, Share and other profiles', keywords: ['select all', 'deselect all', 'remove', 'share all', 'share to', 'prepare all profiles'], Body: SelectAndShare },
    { id: 'auto-settings', title: 'Prepare settings', keywords: ['resume mode', 'cover letters', 'tailor'], Body: PrepareSettings },
  ],
};
