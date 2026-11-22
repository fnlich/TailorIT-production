'use client';

import { SHARE_PERMISSION_ROWS } from '@tailorit/shared/sharing';
import type { PublicMessageKey } from '@/lib/constants';
import { useBoxName } from '../boxes';
import { useGuide } from '../context';
import type { GuideSection } from '../model';
import { AppPage, Aside, Bullets, P, See, Steps, Ui } from '../parts';
import { UsersThreeIcon } from '../icons';
import { FANOUT_COPY } from '../../sharing/fanout/copy';
import { PREPARE_COPY } from '../../settings/prepare/copy';

// v34 HELP: Sharing and profiles: sharing your profile, what is never shared, working on a shared profile, and every
// profile at once, with v3.4's all-profiles actions (PLAN G2-G4; FANWEB builds them in parallel, so each such paragraph
// is marked for INT-B to check against the built UI).

function Share() {
  const { t, get } = useGuide();
  const rows = SHARE_PERMISSION_ROWS.map((row) => t(row.label as PublicMessageKey));
  return (
    <>
      <P>
        You can let another TailorIT account see your Job Tracker, documents and auto-apply, and prepare jobs on your profile;
        they can let you do the same. Each person keeps their own sign-in.
      </P>
      <Steps>
        <li>
          Open <AppPage href="/settings/sharing">Settings › Sharing</AppPage> (the account menu) and choose{' '}
          <Ui>Share your profile</Ui>.
        </li>
        <li>
          Enter their email and choose <Ui>{t('LABEL_SHARING_PRESET_SEE_ONLY')}</Ui>,{' '}
          <Ui>{t('LABEL_SHARING_PRESET_SEE_AND_PREPARE')}</Ui> (the default) or <Ui>{t('LABEL_SHARING_PRESET_CUSTOM')}</Ui>: a{' '}
          {t('LABEL_SHARING_SEE')} box, a {t('LABEL_SHARING_CHANGE')} box or both on each row that has them:{' '}
          {rows.join(', ')}. A box another box needs is ticked for you. An end date is optional.
        </li>
        <li>
          Nothing is emailed: they see the invite in their account menu and in Settings › Sharing, and accept or decline it
          within {get('SHARING_INVITE_DAYS')} days.
        </li>
      </Steps>
      <P>
        Change the boxes any time (they apply on their next request), <Ui>Stop sharing</Ui> (which can also remove the jobs
        they queued that have not started), or cancel an invite; they can <Ui>Leave</Ui>. <Ui>Activity</Ui> shows hourly
        counts of what was done, on both sides. You can share with {get('SHARING_GRANTS_PER_OWNER')} people, work on{' '}
        {get('SHARING_PROFILES_PER_GRANTEE')} profiles shared with you, and send {get('SHARING_INVITES_PER_DAY')} invites a
        day.
      </P>
    </>
  );
}

function NeverShared() {
  const { t } = useGuide();
  return (
    <>
      <Bullets>
        <li>
          Your sign-in, connected AI apps, personal tokens and AI settings, the extension&apos;s connection, job-site
          sign-ins, your name, notification settings, admin, sharing itself, and approving the jobs they queue.
        </li>
        <li>
          Your contact email, phone, address and links stay yours: they cannot change them, and an editable copy they make
          carries yours.
        </li>
        <li>They never delete your applications or documents: they can archive applications, and only you delete.</li>
        <li>
          Your sensitive answers stay hidden unless you tick their <Ui>{t('LABEL_SHARING_ROW_SENSITIVE')}</Ui> box.
        </li>
      </Bullets>
    </>
  );
}

function Working() {
  const { t, get } = useGuide();
  return (
    <>
      <Bullets>
        <li>
          <Ui>Switching</Ui>: the account menu&apos;s profiles (also in the phone&apos;s menu) switch the browser tab to a
          shared profile. A chip beside the AI use meter, the tab&apos;s title and each page say whose profile it is; new tabs
          opened from it stay on it. Pages and buttons follow the boxes the owner ticked, and a refused action says so once.
        </li>
        <li>
          <Ui>Who pays</Ui>: the person working. TailorIT&apos;s AI used on someone else&apos;s profile counts toward your own
          plan, AI use and credit, once however many profiles you work on. The owner keeps their last{' '}
          {get('SHARING_RESUME_RESERVE')} resume places and last {get('SHARING_QUEUE_RESERVE')} queue places.
        </li>
        <li>
          <Ui>The owner&apos;s OK</Ui>: jobs you prepare on someone&apos;s profile show <Ui>{t('STATE_AWAITING_OWNER_OK', { name: 'Ana' })}</Ui>{' '}
          until they approve them, unless they ticked their <Ui>{t('LABEL_SHARING_ROW_APPLY')}</Ui> box. On your own Auto-apply
          page, jobs others prepared for you wait with <Ui>Approve all</Ui> and <Ui>Remove</Ui>; your extension never applies
          to a job waiting for your OK.
        </li>
        <li>
          When access ends (stopped, left, an end date), the tab goes back to your own profile and says so, and their Prepares
          stop.
        </li>
      </Bullets>
    </>
  );
}

function AllProfiles() {
  const { t } = useGuide();
  const boxName = useBoxName();
  return (
    <>
      <P>
        The <AppPage href="/profiles">Profiles</AppPage> page shows a card per profile (what is preparing, waiting for an OK
        and needs you) and <Ui>Prepare all profiles</Ui>, which prepares every profile&apos;s saved jobs after one question
        with each profile&apos;s count and your AI use. The Job Tracker&apos;s <Ui>All profiles</Ui> view puts every
        profile&apos;s applications in one board or list.
      </P>
      <P>
        <Ui>Save to profiles</Ui>: once someone has shared their profile with you, Save is a split button: <Ui>Save</Ui>{' '}
        saves to the profile you are on, and its arrow, <Ui>{FANOUT_COPY.saveTo}</Ui>, offers <Ui>{FANOUT_COPY.you}</Ui>, each
        shared profile, <Ui>{FANOUT_COPY.allProfiles}</Ui> and <Ui>{FANOUT_COPY.chooseProfiles}</Ui>. A job row has the same
        arrow beside its bookmark; the Select bar has <Ui>{FANOUT_COPY.saveTo}</Ui>; Save all has{' '}
        <Ui>{FANOUT_COPY.saveAllTo}</Ui> (each profile saves its own matches for the search, and the question first shows
        each profile&apos;s count); <Ui>Add job</Ui> has <Ui>{FANOUT_COPY.alsoSaveTo}</Ui>. Each profile picks its own
        best-matched resume. A profile whose owner did not tick its <Ui>{boxName('tracker:edit')}</Ui> box is shown but
        off, with the box it needs; while you work on such a profile, the
        Jobs page offers no saving at all (switch to your own profile to save there). Rows and job details say &quot;Saved on&quot; with
        the other profiles that have the job, and the result&apos;s <Ui>Undo</Ui> takes back exactly what it saved. A job
        already saved on the profile you are on is not offered in the Select bar: copy it from the Job Tracker instead
        (below).
      </P>
      <P>
        <Ui>Copy saved jobs</Ui>: in the Job Tracker, <Ui>{t('LABEL_TRACKER_SELECT')}</Ui> › <Ui>{FANOUT_COPY.copyTo}</Ui>{' '}
        saves the selected applications&apos; jobs on other profiles as Saved (their notes, history and documents are not
        copied). The All profiles view has <Ui>{t('LABEL_TRACKER_SELECT')}</Ui> too, with copy, move to a stage, archive and restore (with Undo),
        each on the card&apos;s own profile: a move, archive or restore leaves a card whose profile is shared to see only
        alone, and names it. Its{' '}
        <Ui>Prepare &amp; Queue jobs</Ui> takes the saved jobs of each profile you may prepare, after one question, and{' '}
        <Ui>Prepare all profiles</Ui> is there too.
      </P>
      <P>
        <Ui>Filters for one profile or all</Ui>: while you work on a shared profile you change its Prepare filters with the
        usual form when you have its <Ui>{boxName('settings:edit')}</Ui> box (without it the form says so). The Prepare
        filters form, in Settings and in Auto-apply&apos;s Filters dialog, has <Ui>{FANOUT_COPY.applyTo}</Ui>:{' '}
        <Ui>{FANOUT_COPY.applyThis}</Ui>, <Ui>{FANOUT_COPY.applyAll}</Ui> or <Ui>{FANOUT_COPY.applyChoose}</Ui>. For several
        profiles each filter gets an <Ui>{FANOUT_COPY.mark}</Ui> box: a filter you change is ticked, and ticking one you did
        not change sets it on every chosen profile to the value shown. Only the filters ticked are sent, and{' '}
        <Ui>{FANOUT_COPY.applyChoose}</Ui> sends exactly the profiles you tick (untick yours to change only someone
        else&apos;s). The <Ui>Custom (AI)</Ui> filter&apos;s words go only when you type them in the form, and then replace
        each chosen profile&apos;s own; turning it off leaves every owner&apos;s words as they are, and turning it on without
        new words turns it on for your form&apos;s profile only (the others are named as left out). Where you live stays
        each person&apos;s own, and the eligibility switches (sponsorship, clearance, qualifications) change only where you
        have that profile&apos;s <Ui>{boxName('sensitive:edit')}</Ui> box; elsewhere they are kept and you are told. Prepare
        &amp; Queue settings and the Auto-save rule have <Ui>{FANOUT_COPY.applyOthers}</Ui> (not on a profile you may only
        see): tick the settings and the profiles. <Ui>{PREPARE_COPY.askTitle}</Ui> is not among them: it is each
        person&apos;s own (see <See to="auto-steps">How auto-apply works</See>). The Profiles page shows each profile&apos;s filters in one line, with Edit
        (it opens that profile&apos;s settings; without its <Ui>{boxName('settings:edit')}</Ui> box the card says so) and{' '}
        <Ui>{FANOUT_COPY.filtersAll}</Ui>, which starts from your own filters.
      </P>
      <Aside title="One action, many profiles">
        <P>
          An action on several profiles is one request, and one message says what happened on each: a short note when every
          profile did it, one alert listing each profile when one did not. A profile whose owner did not tick the box the
          action needs is off in the choice, with the box it needs; All profiles means you and every shared profile that
          allows the action, and the others are named as left out, with the box their owner can tick. A profile where
          nothing happened (a job it cannot see, nothing new) is named with why. Archiving works on several profiles at
          once; deleting stays each owner&apos;s.
        </P>
      </Aside>
      <P>
        Your own AI does the same: see <See to="mcp-profiles">Shared profiles with your AI</See>.
      </P>
    </>
  );
}

export const SHARING_SECTION: GuideSection = {
  id: 'sharing',
  title: 'Sharing and profiles',
  icon: UsersThreeIcon,
  keywords: ['share', 'profiles', 'grant', 'invite', 'all profiles'],
  topics: [
    { id: 'sharing-share', title: 'Share your profile', keywords: ['invite', 'boxes', 'permissions', 'stop sharing'], Body: Share },
    { id: 'sharing-never', title: 'What is never shared', keywords: ['privacy'], Body: NeverShared },
    { id: 'sharing-work', title: 'Working on a shared profile', keywords: ['switch', 'pays', 'ok', 'approve'], Body: Working },
    { id: 'sharing-all', title: 'Every profile at once', keywords: ['save to', 'copy', 'filters', 'prepare all profiles'], Body: AllProfiles },
  ],
};
