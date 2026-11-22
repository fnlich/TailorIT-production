'use client';

import { agentSitesText, queueSitesText } from '../../auto-apply/copy';
import { useGuide } from '../context';
import type { GuideSection } from '../model';
import { AppPage, Bullets, P, See, Steps, Ui } from '../parts';
import { PuzzlePieceIcon } from '../icons';

// v34 HELP: The browser extension: installing and connecting it, filling applications, and auto-apply.

function Install() {
  return (
    <>
      <P>
        The TailorIT extension fills job applications in your desktop browser and applies to the jobs in your auto-apply
        queue. It is not in a browser&apos;s store yet: your admin gives you its folder, and while no browser is connected{' '}
        <AppPage href="/settings/autofill?tab=extension">Autofill › Extension</AppPage> shows how to build and load it (the
        browser&apos;s extensions page, Developer mode, Load unpacked).
      </P>
      <Steps>
        <li>
          Load the extension, then choose <Ui>Connect the extension</Ui> on that page (or connect from the extension&apos;s
          options page).
        </li>
        <li>
          Choose what this browser may do: read and change your work authorization and self-identification answers (ticked
          unless you untick it), and sign in to job sites with the password you saved (off unless you tick it, asked again for
          each connection).
        </li>
        <li>
          <Ui>Connected browsers</Ui> lists each browser with what it may do and when its connection expires;{' '}
          <Ui>Disconnect</Ui> ends one.
        </li>
      </Steps>
    </>
  );
}

function Fill() {
  return (
    <Bullets>
      <li>
        On an application page you open yourself, the extension fills the form from your Autofill profile and your saved
        answers, attaches your resume and, when the form wants one, a cover letter. You check and submit.
      </li>
      <li>
        A question your profile cannot answer is answered with AI where that is allowed, and marked so you can check it.
        Sensitive answers are never sent to AI.
      </li>
      <li>On a job page it can add the job to TailorIT and save it to your Job Tracker.</li>
      <li>With your permission it signs in to job sites with the sign-in you saved in Autofill › Job-site sign-in.</li>
    </Bullets>
  );
}

function AutoApply() {
  const { get, t } = useGuide();
  const free = get('FREE_AUTO_APPLY_PER_DAY');
  return (
    <>
      <Bullets>
        <li>
          <Ui>Run auto-apply</Ui> takes the ready jobs of your queue one at a time, in the background, on {agentSitesText()}.
        </li>
        <li>
          Its <Ui>Queue tab</Ui> opens ready jobs in tabs you watch, and also takes jobs on {queueSitesText()}.
        </li>
        <li>
          Answers your AI or TailorIT&apos;s AI guessed are sent as they are. A CAPTCHA, a code sent to your email or a sign-in
          stops a job as <Ui>{t('STATE_NEEDS_YOU')}</Ui>: open it, finish, and choose Try again or{' '}
          <Ui>{t('LABEL_JOB_MARK_APPLIED')}</Ui>.
        </li>
        <li>
          On a Free account the extension applies to {free === null ? 'any number of' : free} jobs a day. A job counts when
          the extension takes it, and is given back if the run fails, is skipped or stops for you before it was sent. Jobs you
          apply to yourself never count.
        </li>
      </Bullets>
      <P>
        See <See to="auto-queue">The queue</See> for what each state means.
      </P>
    </>
  );
}

export const EXTENSION_SECTION: GuideSection = {
  id: 'extension',
  title: 'The browser extension',
  icon: PuzzlePieceIcon,
  keywords: ['extension', 'browser', 'autofill', 'auto-apply'],
  topics: [
    { id: 'ext-install', title: 'Install and connect', keywords: ['pair', 'connect', 'install'], Body: Install },
    { id: 'ext-fill', title: 'Filling applications', keywords: ['fill', 'form'], Body: Fill },
    { id: 'ext-auto', title: 'Run auto-apply and the Queue tab', keywords: ['run', 'queue tab', 'needs you'], Body: AutoApply },
  ],
};
