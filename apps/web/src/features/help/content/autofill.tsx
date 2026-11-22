'use client';

import { MagicWandIcon } from '@/components/ui/icons';
import { WIZARD_STEPS } from '../../autofill/profile/wizard';
import { useGuide } from '../context';
import type { GuideSection } from '../model';
import { AppPage, Bullets, P, Ui } from '../parts';

// v34 HELP: the Autofill profile (Settings › Autofill): the profile's steps, Fill from my resume, saved answers,
// job-site sign-ins, and the sensitive answers that never reach AI.

function Profile() {
  const { t } = useGuide();
  return (
    <>
      <P>
        <AppPage href="/settings/autofill">Autofill</AppPage> (the account menu) holds what the extension fills into
        applications and what Prepare &amp; Queue writes answers from. Its <Ui>Profile</Ui> tab goes step by step:{' '}
        {WIZARD_STEPS.map((step) => step.title).join(', ')}.
      </P>
      <Bullets>
        <li>
          <Ui>Fill from my resume</Ui> reads an uploaded resume once with AI (counted as a resume import; the file itself is
          never changed) and fills only what the file says. Every field it read is marked{' '}
          <Ui>{t('LABEL_AUTOFILL_AI_READ')}</Ui> until you edit it, and <Ui>{t('LABEL_AUTOFILL_CHECK_THESE')}</Ui> lists what
          the fill could not be sure of. Filling again keeps the answers you already gave.
        </li>
        <li>
          <Ui>Answer these once</Ui> lists the answers the extension never guesses or sends to AI (work authorization,
          sponsorship, criminal record, equal opportunity) and which of them you have not given yet; left empty, one stays
          blank, or is declined on equal opportunity forms.
        </li>
      </Bullets>
    </>
  );
}

function Answers() {
  return (
    <Bullets>
      <li>
        <Ui>Saved answers</Ui>: answers the extension reuses when a form asks the same question again. Answer a question the
        extension flagged on a form, and it is saved here; edit or delete any of them.
      </li>
      <li>
        <Ui>Job-site sign-in</Ui>: for job sites that need an account before you apply, one sign-in for all the job
        platforms that need an account, or one per site, kept encrypted. The extension uses it only in a browser you allowed to.
      </li>
      <li>
        <Ui>Extension</Ui>: connecting the browser extension (see the next section).
      </li>
    </Bullets>
  );
}

function Sensitive() {
  const { t } = useGuide();
  return (
    <P>
      Self-identification (gender, race, disability, veteran status), work authorization and visa answers, legal answers
      (age, criminal record, clearance, citizenship and the like) and pay expectations are <Ui>sensitive answers</Ui>. They are filled only by the extension, from your profile, in a browser you
      allowed to read them; they are never sent to any AI (TailorIT&apos;s or yours) and never shown to someone you share
      your profile with unless you tick their <Ui>{t('LABEL_SHARING_ROW_SENSITIVE')}</Ui> box.
    </P>
  );
}

export const AUTOFILL_SECTION: GuideSection = {
  id: 'autofill',
  title: 'Autofill profile',
  icon: MagicWandIcon,
  keywords: ['autofill', 'profile', 'answers'],
  topics: [
    { id: 'autofill-profile', title: 'Your profile', keywords: ['fill from my resume', 'wizard'], Body: Profile },
    { id: 'autofill-answers', title: 'Saved answers and job-site sign-ins', keywords: ['password', 'sign-in'], Body: Answers },
    { id: 'autofill-sensitive', title: 'Sensitive answers', keywords: ['eeo', 'visa', 'disability', 'veteran', 'privacy'], Body: Sensitive },
  ],
};
