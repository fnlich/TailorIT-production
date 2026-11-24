'use client';

import { APP_NAV, ACCOUNT_NAV } from '@/components/shell/layout';
import { USAGE_COPY } from '@/components/shell/header/copy';
import { WHERE_YOU_LIVE_HREF } from '../../jobs/toolbar/CanApplySwitch';
import { useGuide } from '../context';
import type { GuideSection } from '../model';
import { AppPage, Bullets, P, See, Steps, Ui } from '../parts';
import { RocketLaunchIcon } from '../icons';

// v34 HELP: Getting started: what TailorIT is, the first steps, and finding your way around.

function WhatItDoes() {
  return (
    <>
      <P>
        TailorIT is a workspace for your job search. You find jobs among the postings TailorIT reads, keep each one you care
        about in your Job Tracker, prepare an application kit for it (a resume made for the job, a cover letter when one is
        wanted, and answers to the form&apos;s questions), and let the TailorIT browser extension apply for you. Your resumes,
        cover letters and letter templates live in Documents.
      </P>
      <P>
        You can do all of it on the pages, or ask your own AI app to do it with you: Claude, ChatGPT or another app that
        speaks MCP connects to your account and can search, save, count and prepare for you (see{' '}
        <See to="mcp">Use TailorIT from your AI</See>).
      </P>
    </>
  );
}

function FirstSteps() {
  const { t } = useGuide();
  return (
    <Steps>
      <li>
        <Ui>Sign in.</Ui> TailorIT has no passwords: sign in with a code sent to your email, or with the other sign-in
        button the page offers.
      </li>
      <li>
        <Ui>Add a resume.</Ui> In <AppPage href="/documents">Documents</AppPage> choose <Ui>Upload</Ui> (a PDF or Word file)
        or <Ui>{t('LABEL_DOCS_NEW')}</Ui> › <Ui>{t('LABEL_DOCS_NEW_RESUME')}</Ui>. Your first resume becomes your default
        resume: jobs are matched to it, and it sets <Ui>{t('LABEL_ACCOUNT_YOUR_FIELD')}</Ui>, the kind of work TailorIT
        writes for. An uploaded file is kept exactly as you uploaded it.
      </li>
      <li>
        <Ui>Say where you live.</Ui> <AppPage href={WHERE_YOU_LIVE_HREF}>Settings › Job preferences</AppPage> holds
        your country, state, city and time zone, so TailorIT can tell which jobs you may apply to.
      </li>
      <li>
        <Ui>Find jobs and save them.</Ui> On <AppPage href="/jobs">Jobs</AppPage> search, open a job, and choose{' '}
        <Ui>Save</Ui>. Saved jobs go to your <AppPage href="/tracker">Job Tracker</AppPage>.
      </li>
      <li>
        <Ui>Fill in your Autofill profile</Ui> (<AppPage href="/settings/autofill">Autofill</AppPage>): your details,
        education, experience and the answers forms ask for. The extension fills applications from it.
      </li>
      <li>
        <Ui>Check how jobs are prepared</Ui> (<AppPage href="/settings#prepare">Settings › Prepare</AppPage>): the
        resume setting, cover letters and your Prepare filters decide what Prepare makes, and for which jobs.
      </li>
      <li>
        <Ui>Install and connect the extension</Ui> (<AppPage href="/settings/autofill?tab=extension">Autofill › Extension</AppPage>
        ), then <Ui>Prepare</Ui> your saved jobs on <AppPage href="/auto-apply">Auto-apply</AppPage>.
      </li>
      <li>
        <Ui>Connect your AI</Ui> if you like (<AppPage href="/settings/integrations">Integrations</AppPage>), and ask it
        in your own words. A first request to try: &quot;Read TailorIT&apos;s rules first, then tell me what you can do
        here.&quot; (see <See to="mcp-connect-claude">Connect Claude</See>).
      </li>
    </Steps>
  );
}

function FindingYourWay() {
  const { frame } = useGuide();
  const work = APP_NAV.map((item) => item.label).join(', ');
  const setup = ACCOUNT_NAV.filter((item) => !('adminOnly' in item && item.adminOnly)).map((item) => item.label);
  return (
    <>
      <P>
        The dark bar at the top holds the work, in its order: <Ui>{work}</Ui>. On a phone or a narrow window the menu button
        at its left opens the same links.
      </P>
      <Bullets>
        <li>
          <Ui>AI use</Ui>: the meter beside the bell shows how much of today&apos;s AI use you have spent, as a percent, and
          your extra credit (<Ui>{USAGE_COPY.extraTitle}</Ui>). It starts again each day (see <See to="plans">Plans and limits</See>).
        </li>
        <li>
          <Ui>The bell</Ui>: your notifications (applications prepared, auto-apply results, jobs you added, your AI use,
          the extension, sharing). The latest are in its window; <AppPage href="/notifications">Notifications</AppPage>{' '}
          lists all of them.
        </li>
        <li>
          <Ui>The account menu</Ui> (your initials): {setup.join(', ')}, and Log out.
          {frame === 'app' ? ' This guide is its Help item.' : ''} Once someone shares their profile with you, the menu also
          lists your profiles.
        </li>
        <li>
          <Ui>The &quot;?&quot; buttons</Ui> beside titles say in one sentence what a page, a section or a setting is for.
        </li>
      </Bullets>
    </>
  );
}

export const START_SECTION: GuideSection = {
  id: 'getting-started',
  title: 'Getting started',
  icon: RocketLaunchIcon,
  keywords: ['start', 'begin', 'first', 'overview', 'navigation'],
  topics: [
    { id: 'start-what', title: 'What TailorIT does', Body: WhatItDoes },
    { id: 'start-first-steps', title: 'Your first steps', keywords: ['sign in', 'setup'], Body: FirstSteps },
    { id: 'start-around', title: 'Finding your way around', keywords: ['menu', 'header', 'bell', 'account'], Body: FindingYourWay },
  ],
};
