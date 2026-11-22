'use client';

import { DELETE_COPY } from '../account-deletion/copy'; // v34 FIX-COPY
import { ACCOUNT_COPY } from '../settings/account'; // v34 FIX-COPY
import { ContactAddress, OperatorName, OperatorWebsite, useOperator } from './OperatorParts';
import { POLICY_UPDATED, PolicyPage, PolicySection, sectionOf } from './PolicyPage';
import { B, Bullets, P, TextLink } from './prose';

// v34 PUBLIC (PLAN G8): plain terms of use for this TailorIT service, naming its operator from the public constants
// (OPERATOR_NAME, OPERATOR_WEBSITE, ADMIN_CONTACT_EMAIL). A template the operator reviews before going public
// (DEPLOYMENT.md), not legal advice; the page itself never says so.

export const TERMS_SECTIONS = [
  { id: 'service', title: 'The service' },
  { id: 'account', title: 'Your account' },
  { id: 'content', title: 'Your content' },
  { id: 'ai-output', title: 'AI help can be wrong' },
  { id: 'acceptable-use', title: 'Acceptable use' },
  { id: 'connected-apps', title: 'AI apps and the browser extension' },
  { id: 'jobs', title: 'Job postings' },
  { id: 'plans', title: 'Plans and limits' },
  { id: 'availability', title: 'Availability and changes' },
  { id: 'ending', title: 'Ending your use' },
  { id: 'liability', title: 'Disclaimers and limits of liability' },
  { id: 'changes', title: 'Changes to these terms' },
  { id: 'contact', title: 'Contact' },
] as const;

const at = (id: (typeof TERMS_SECTIONS)[number]['id']) => sectionOf(TERMS_SECTIONS, id);

export function TermsPage() {
  const operator = useOperator();

  return (
    <PolicyPage
      title="Terms of use"
      updated={POLICY_UPDATED}
      testId="terms"
      sections={TERMS_SECTIONS}
      lead={
        <P>
          These terms apply when you use this TailorIT service. By continuing past the sign-in page, you accept them.
          Please read them with the <TextLink href="/privacy">Privacy policy</TextLink>, which says what TailorIT keeps
          about you.
        </P>
      }
    >
      <PolicySection section={at('service')}>
        <P>
          TailorIT is a job search workspace: you find jobs, keep your resumes and cover letters, track your applications,
          and prepare them, with AI help and a browser extension that fills in application forms if you choose. This
          service is run by <OperatorName state={operator} /> (&quot;we&quot; below).
          <OperatorWebsite state={operator} />
        </P>
      </PolicySection>

      <PolicySection section={at('account')}>
        <Bullets>
          <li>Sign in with an email address you can read: TailorIT sends your sign-in codes there.</li>
          <li>One account is for one person. Keep your sign-in codes and access tokens to yourself.</li>
          <li>
            You are responsible for what is done with your account, including by the AI apps you connect and by the people
            you share your profile with, within the boxes you tick for them.
          </li>
          <li>Tell us at once if you think someone else used your account.</li>
        </Bullets>
      </PolicySection>

      <PolicySection section={at('content')}>
        <P>
          Your resumes, cover letters, answers and other content stay yours. You let us store, process and show them only
          to run TailorIT for you, which includes sending the text an AI task needs to our AI provider (see the{' '}
          <TextLink href="/privacy#ai">Privacy policy</TextLink>). Upload only what you have the right to use, and do not
          upload anyone else&apos;s personal data without their permission. Uploaded files are kept exactly as you
          uploaded them.
        </P>
      </PolicySection>

      <PolicySection section={at('ai-output')}>
        <P>
          Tailored resumes, cover letters, suggested answers, matches and filter results are written by AI and can be
          wrong, out of date or incomplete. Read and correct everything before you send it to an employer. Never let it
          claim experience, skills or facts that are not true. You decide what you send, and you are responsible for it.
        </P>
      </PolicySection>

      <PolicySection section={at('acceptable-use')}>
        <P>Do not use TailorIT to:</P>
        <Bullets>
          <li>break the law, or the terms of the job sites and employers you apply to;</li>
          <li>
            get past a CAPTCHA, a bot check or a sign-in code: TailorIT stops and asks you when it meets one, and you must
            not work around that;
          </li>
          <li>flood employers or job sites with automated applications, or apply to jobs you do not mean to take;</li>
          <li>
            overload, copy in bulk or probe TailorIT, get around its limits, or use another person&apos;s account or token;
          </li>
          <li>upload harmful files, or pretend to be someone else.</li>
        </Bullets>
      </PolicySection>

      <PolicySection section={at('connected-apps')}>
        <P>
          You choose whether to connect an AI app (such as Claude or ChatGPT) or the browser extension. A connected app
          acts for you with the access you approved, under its own terms; you can disconnect it at any time in{' '}
          <B>Settings › Integrations</B>. The browser extension fills in forms in your own browser, and applies by itself
          only to the jobs you queued for auto-apply. Check what it filled when it asks you to.
        </P>
      </PolicySection>

      <PolicySection section={at('jobs')}>
        <P>
          Job postings come from public job boards, company career sites and links people add. We do not check every
          posting and cannot promise that one is accurate, current or still open. We are not the employer and take no part
          in hiring decisions.
        </P>
      </PolicySection>

      <PolicySection section={at('plans')}>
        <P>
          TailorIT has Free and Paid plans. Their limits are shown in the app and in the{' '}
          <TextLink href="/guide">User Guide</TextLink>, and may change. TailorIT takes no payment itself: a subscription
          or extra credit is arranged with us.
        </P>
      </PolicySection>

      <PolicySection section={at('availability')}>
        <P>
          We work to keep TailorIT running, but it may be unavailable at times, for example for maintenance. We may add,
          change or remove features. If we stop running the service, we will tell you in advance where we can, so you can
          download your files first.
        </P>
      </PolicySection>

      <PolicySection section={at('ending')}>
        <P>
          {/* v34 FIX-COPY (final review dir D5): since ACCTDEL you delete your account yourself. */}
          You can stop using TailorIT at any time and delete your account yourself in{' '}
          <B>
            Settings › {ACCOUNT_COPY.title} › {DELETE_COPY.openSelf}
          </B>
          , or ask us to (see the <TextLink href="/privacy#choices">Privacy policy</TextLink>). We may suspend or close an account that breaks
          these terms or puts the service or other people at risk; where we can, we tell you why first.
        </P>
      </PolicySection>

      <PolicySection section={at('liability')}>
        <P>
          TailorIT is provided as it is, without promises that it will find you a job, be free of errors or always be
          available. As far as the law allows, we are not liable for lost opportunities, job outcomes, lost data or any
          indirect loss, and our total liability to you is limited to what you paid us for the service in the twelve months
          before the claim. Nothing in these terms takes away rights the law gives you that cannot be taken away.
        </P>
      </PolicySection>

      <PolicySection section={at('changes')}>
        <P>
          We may change these terms. The date at the top says when they last changed. We tell you in TailorIT before a
          change that matters takes effect; if you keep using TailorIT afterwards, the new terms apply.
        </P>
      </PolicySection>

      <PolicySection section={at('contact')}>
        <P>
          Questions about these terms: <ContactAddress state={operator} /> For help with TailorIT, see{' '}
          <TextLink href="/support">Support</TextLink>.
        </P>
      </PolicySection>
    </PolicyPage>
  );
}
