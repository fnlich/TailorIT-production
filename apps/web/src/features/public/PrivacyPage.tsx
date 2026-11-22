'use client';

import { usePublicConstants } from '@/lib/constants';
import { AccountDeletionText, CHILD_ACCOUNT_DELETION, RETENTION_DELETION } from './AccountDeletion'; // v34 ACCTDEL: RETENTION_DELETION
import { ContactAddress, OperatorName, OperatorWebsite, useOperator } from './OperatorParts';
import { GUIDE_ANCHORS, guideLink } from './paths';
import { POLICY_UPDATED, PolicyPage, PolicySection, sectionOf } from './PolicyPage';
import { B, Bullets, P, TextLink, days, minutes } from './prose';

// v34 PUBLIC (PLAN G8; an AI directory rejects a listing without a privacy policy covering what is collected, how it is
// used and how long it is kept): what TailorIT stores, why, who handles it, how long it is kept and how to have it
// removed, as the code does it (read 2026-11-21, corrected after the review; SP v34 build PUBLIC.md lists where each
// statement is met). The numbers are public constants, so an admin's change shows here at once; the operator's name,
// website and contact address are OPERATOR_NAME, OPERATOR_WEBSITE and ADMIN_CONTACT_EMAIL. How an account is deleted is
// one block of its own (AccountDeletion.tsx, DELETION_TEXT). It is a template the operator reviews before going public
// (DEPLOYMENT.md), not legal advice; the page itself never says so.

export const PRIVACY_SECTIONS = [
  { id: 'who', title: 'Who runs this service' },
  { id: 'collect', title: 'What TailorIT keeps' },
  { id: 'use', title: 'How it is used' },
  { id: 'ai', title: 'AI processing' },
  { id: 'others', title: 'Who else handles it' },
  { id: 'ai-apps', title: 'AI apps you connect' },
  { id: 'cookies', title: 'Cookies and browser storage' },
  { id: 'retention', title: 'How long it is kept' },
  { id: 'choices', title: 'Change, export or delete' },
  { id: 'security', title: 'Security' },
  { id: 'children', title: 'Children' },
  { id: 'rights', title: 'Your rights' },
  { id: 'changes', title: 'Changes to this policy' },
  { id: 'contact', title: 'Contact' },
] as const;

const at = (id: (typeof PRIVACY_SECTIONS)[number]['id']) => sectionOf(PRIVACY_SECTIONS, id);

export function PrivacyPage() {
  const operator = useOperator();
  const { get, t } = usePublicConstants();
  const aiDays = days(get('AI_TASK_KEEP_DAYS'));

  return (
    <PolicyPage
      title="Privacy policy"
      updated={POLICY_UPDATED}
      testId="privacy"
      sections={PRIVACY_SECTIONS}
      lead={
        <P>
          This policy explains what this TailorIT service keeps about you, why, who else handles it, how long it is kept and
          how to have it removed. TailorIT is a job search workspace: you find jobs, keep your resumes and cover letters,
          track your applications and prepare them, with AI help and a browser extension if you choose.
        </P>
      }
    >
      <PolicySection section={at('who')}>
        <P>
          This TailorIT service is run by <OperatorName state={operator} /> (&quot;we&quot; below), who decides how your data
          is used here and is responsible for it.
          <OperatorWebsite state={operator} /> See <TextLink href="#contact">Contact</TextLink> for how to reach us.
        </P>
      </PolicySection>

      <PolicySection section={at('collect')}>
        <P>TailorIT keeps what you give it and what it needs to run the features you use:</P>
        <Bullets>
          <li>
            <B>Your account.</B> Your email address and name. If you sign in with Google, the name, picture address and
            account id Google sends. For each signed-in session: when it started and was last used, your browser&apos;s
            name and your network address.
          </li>
          <li>
            <B>Resumes.</B> The files you upload, kept exactly as you uploaded them, and the text read from them; the
            resumes you write, copy or tailor in the editor; a photo, if you add one.
          </li>
          <li>
            <B>Cover letters</B> and letter templates you write or import, and other files you upload (a job list to
            import, for example).
          </li>
          <li>
            <B>Your Autofill profile.</B> Your contact details, links, education, work history, job preferences and where
            you live, and the answers you save for application forms.
          </li>
          <li>
            <B>Sensitive answers.</B> Work authorization, visa and sponsorship, citizenship and security clearance;
            self-identification (such as gender, pronouns, ethnicity and race, sexual orientation, disability and veteran
            status); whether you are 18 or over; criminal record; relatives at an employer, agreements with a former
            employer, government service and whether you can perform a job&apos;s essential functions; and pay
            expectations. They are kept apart from the rest of your profile so the browser extension can fill them in for
            you. They are never sent to an AI, and a person you share your profile with sees them only if you tick{' '}
            <B>Sensitive answers</B> for them.
          </li>
          <li>
            <B>Your job search.</B> Your searches and saved searches; the jobs you save, hide, open or add by link; your
            Job Tracker (status, notes, status history, the resume and letter you used); the application kits you
            prepare and your auto-apply queue; and, if you keep them, the questions and answers of the forms you sent.
          </li>
          <li>
            <B>Job-site sign-ins</B>, only if you choose to save them: the site, the email address and the password. The
            password is encrypted before it is stored, and only your connected browser extension can read it back.
          </li>
          <li>
            <B>Your AI connections.</B> The personal access tokens you create and the AI apps you connect (which app, when
            it was connected and last used), your custom instructions for your AI, and the requests your AI reported it
            could not do.
          </li>
          <li>
            <B>Sharing.</B> Whom you shared your profile with (their email address), the boxes you ticked for them, and
            hourly counts of what was done on a shared profile (which kinds of action, never their content).
          </li>
          <li>
            <B>The browser extension.</B> When you connect it: its name and your browser. Afterwards: the job postings you
            add from a page, the questions it asks the AI about a form, the sites you ask TailorIT to support, and the
            jobs you report as closed.
          </li>
          <li>
            <B>Notifications</B> TailorIT shows you inside the app, and <B>reports</B> you send about a job.
          </li>
          <li>
            <B>Plan and usage records.</B> Your plan, extra credit and how much AI your account used, so limits and plans
            work.
          </li>
        </Bullets>
      </PolicySection>

      <PolicySection section={at('use')}>
        <P>We use your data only to run TailorIT for you:</P>
        <Bullets>
          <li>to sign you in and keep your account secure;</li>
          <li>
            to match jobs to your resumes, tailor resumes, write cover letters, fill in application forms through your
            browser extension, track your applications and prepare and queue them;
          </li>
          <li>to let the people you choose work on your profile, within the boxes you tick;</li>
          <li>to show you notifications, and to keep plans, limits and usage counts;</li>
          <li>to keep the service working and safe (finding faults, stopping abuse).</li>
        </Bullets>
        <P>
          We do not sell your data, rent it, or use it for advertising. TailorIT itself trains no AI model on it. The only
          email TailorIT sends you is your sign-in code.
        </P>
      </PolicySection>

      <PolicySection section={at('ai')}>
        <P>
          TailorIT uses Claude, an AI model made by Anthropic, for its AI tasks: reading the resumes you upload and matching
          them to jobs, tailoring a resume to a job, writing and improving resume bullet points, writing cover letters and
          filling letter templates, suggesting answers to application questions, judging jobs against your own filter, and
          AI job search. For each task, TailorIT sends Anthropic only the text the task needs: your resume text or facts,
          the job posting, your search sentence or filter, and the question to answer. Your name and contact details are
          left out wherever the task does not need them. Anthropic handles that text under its own terms and privacy
          policy.
        </P>
        <P>
          Your saved sensitive answers are never sent to an AI. If you let the browser extension answer every question
          with AI, a question about work authorization, sponsorship, age, criminal history or pay is sent with the resume
          and profile facts above so the AI can suggest an answer, still without your saved sensitive answers.
          Self-identification questions are never sent.
        </P>
        <P>
          Results you keep (a tailored resume, a cover letter, an answer) stay in your account until you delete them. What
          was sent to the AI for a task, and its answer, are deleted within {aiDays} of the task.
        </P>
      </PolicySection>

      <PolicySection section={at('others')}>
        <Bullets>
          <li>
            <B>Anthropic</B> runs the AI tasks above.
          </li>
          <li>
            <B>Our email service</B> delivers your sign-in codes.
          </li>
          <li>
            <B>Google</B>, if you sign in with Google: Google confirms who you are, and the sign-in page loads Google&apos;s
            sign-in button only when that option is offered.
          </li>
          <li>
            <B>Our hosting provider</B> keeps the servers and backups this service runs on.
          </li>
          <li>
            <B>AI apps you connect</B> read and change your TailorIT data as you allowed (see{' '}
            <TextLink href="#ai-apps">AI apps you connect</TextLink>).
          </li>
          {/* v34 FIX-COPY (final review dir D2): what ticking Their own AI opens, as the Sharing page's tip says. */}
          <li>
            <B>People you share your profile with</B> see and change what the boxes you ticked allow. If you tick{' '}
            <B>{t('LABEL_SHARING_ROW_MCP')}</B> for someone, their AI app may read and prepare your profile within those
            boxes, so what it reads reaches that app and their AI provider.
          </li>
          <li>
            <B>Employers.</B> When you apply, your browser extension fills the employer&apos;s form with your profile and
            documents and sends it to the employer&apos;s site. What the employer does with it is up to their own policy.
          </li>
          <li>
            <B>Other people using TailorIT</B> may see a job you added by its link once it is checked and listed for
            everyone; who added it is not shown.
          </li>
          <li>
            <B>Administrators</B> of this service see each account&apos;s email address, name, plan and usage, and the
            reports you send about jobs, to run it.
          </li>
        </Bullets>
        <P>
          Anthropic and our other providers may process your data in other countries, including the United States.
          TailorIT reads public job postings from job boards and company career sites, and public facts about companies,
          and sends them nothing about you. We disclose data to others only when the law requires it.
        </P>
      </PolicySection>

      <PolicySection section={at('ai-apps')}>
        <P>
          You can connect an AI app such as Claude or ChatGPT to your account, or give an app you run yourself a personal
          access token (<B>Settings › Integrations</B>). A connected app can do what TailorIT&apos;s tools allow: search
          jobs and read their details, and use TailorIT&apos;s AI job search where your plan includes it; read your Job
          Tracker, its statistics and your auto-apply queue; save, archive and add jobs, and remove jobs from your queue;
          run your saved filters (it reads your own filter&apos;s words); write resumes, cover letters and answers for your
          applications (it reads your resumes, the posting and the form&apos;s questions, and saves what it writes); change
          your Prepare settings and filters; start Prepare &amp; Queue and queue prepared jobs; and tell TailorIT what it
          could not do. It can do the same on profiles other people share with you, as far as the boxes they ticked
          allow.
        </P>
        <P>
          It never sees your sign-in codes, your job-site passwords or your saved sensitive answers, and it cannot use your
          browser extension: it can queue a prepared job, and your extension applies. It does not read those answers, nor
          your sponsorship and clearance filter switches (it changes them only when you ask). It can see that
          TailorIT&apos;s filters set a job aside on qualifications or on eligibility, never which of your answers, which
          may still hint, for example, that you need visa sponsorship.
        </P>
        <P>
          What a connected app reads goes to that app and its AI provider, under their own terms. To disconnect an app,
          choose <B>Disconnect</B> beside it in <B>Settings › Integrations</B>: every token of that connection stops
          working at once. Personal access tokens work until you revoke them there. A connected app that has not used
          TailorIT for {days(get('OAUTH_REFRESH_IDLE_DAYS'))} is disconnected.
        </P>
      </PolicySection>

      <PolicySection section={at('cookies')}>
        <P>
          TailorIT sets one cookie to keep you signed in (<B>ti_session</B>, readable only by the server, ending after a
          set number of days or when you sign out). While you approve an AI app, a second cookie (<B>ti_oauth</B>) ties
          that approval to your browser for {minutes(get('OAUTH_REQUEST_MINUTES'))}. There are no advertising, tracking or
          analytics cookies. If you use Google sign-in, Google&apos;s button may use Google&apos;s own cookies.
        </P>
        <P>
          Your browser also keeps a few things on your device, such as how you arranged your Job Tracker, and resume edits
          you have not saved yet. They stay on your device, and the unsaved edits are removed when you save or sign out.
          The browser extension keeps its connection and your settings in your browser.
        </P>
      </PolicySection>

      <PolicySection section={at('retention')}>
        <Bullets>
          <li>
            Your account, resumes, letters, files, profile, answers and Job Tracker are kept while your account exists, or
            until you delete them.
          </li>
          <li>Notifications are deleted after {days(get('NOTIFICATIONS_KEEP_DAYS'))}, read or not.</li>
          <li>
            Counts of what was done on a shared profile are deleted after {days(get('SHARING_ACTIVITY_KEEP_DAYS'))}
            {RETENTION_DELETION.sharingCounts}.
          </li>
          <li>What was sent to the AI for a task, and its answer, are deleted within {aiDays} of the task.</li>
          <li>
            Records of AI apps you disconnected, and their ended tokens, are deleted{' '}
            {days(get('OAUTH_RECORD_KEEP_DAYS'))} after they end; ended browser extension connections,{' '}
            {days(get('EXTENSION_TOKEN_KEEP_DAYS'))} after they end.
          </li>
          <li>A sharing invite expires after {days(get('SHARING_INVITE_DAYS'))} if it is not accepted.</li>
          <li>Sign-in codes are deleted once used and soon after they expire; sessions are deleted when they end.</li>
          <li>
            The record of each application you sent, with a copy of the resume and cover letter you sent (an uploaded file
            included), and your plan, credit and usage history are kept while your account exists, even after you delete
            the resume or the Job Tracker entry.
          </li>
          <li>
            Revoked access tokens (their name and dates) and ended sharing (with whom, by email address, the boxes and the
            dates) are kept while your account exists{RETENTION_DELETION.endedSharing}.
          </li>
          <li>{RETENTION_DELETION.cutShort}</li>
          <li>
            The server&apos;s logs record sign-ups and administrators&apos; actions, with email addresses; we keep them only
            as long as we need them to run the service.
          </li>
          <li>Backups may hold deleted data until they are replaced.</li>
        </Bullets>
      </PolicySection>

      <PolicySection section={at('choices')}>
        <Bullets>
          <li>
            <B>Change</B> your name, profile, answers, sensitive answers, filters and settings at any time.
          </li>
          <li>
            <B>Delete</B> resumes, cover letters, templates, Job Tracker entries, saved answers and job-site sign-ins
            yourself; disconnect extension connections and connected AI apps, and revoke access tokens. Deleting a resume
            also deletes its file and the text read from it.
          </li>
          <li>
            <B>Stop sharing</B> your profile, or leave a profile shared with you, at any time (<B>Settings › Sharing</B>).
          </li>
          <li>
            <B>Export</B> your Job Tracker as a spreadsheet file and download your files.
          </li>
          <li>
            <AccountDeletionText />
          </li>
        </Bullets>
      </PolicySection>

      <PolicySection section={at('security')}>
        <P>
          Sign-in codes, sessions, access tokens and connected-app tokens are stored only as one-way fingerprints, never as
          themselves. Job-site passwords are encrypted with a key kept apart from the database. Sign-in codes expire within
          minutes and allow only a few tries, requests are rate limited, and changes sent from other websites are
          refused. Sensitive answers are kept apart from the rest of your profile. No system is perfectly secure: tell us
          at once if you think someone used your account.
        </P>
      </PolicySection>

      <PolicySection section={at('children')}>
        <P>
          TailorIT is a job search tool for adults and is not meant for children under 16. We do not knowingly keep data
          about children; if you believe a child has an account, {CHILD_ACCOUNT_DELETION}
        </P>
      </PolicySection>

      <PolicySection section={at('rights')}>
        <P>
          Depending on where you live, you may have the right to see the data we keep about you, correct it, delete it,
          take a copy, or object to how it is used, and to complain to your data protection authority. Most of this you
          can do yourself in TailorIT (see <TextLink href="#choices">Change, export or delete</TextLink>); for the rest,
          ask us.
        </P>
      </PolicySection>

      <PolicySection section={at('changes')}>
        <P>
          We may change this policy. The date at the top says when it last changed. We tell you in TailorIT before a
          change that affects how your data is used takes effect.
        </P>
      </PolicySection>

      <PolicySection section={at('contact')}>
        <P>
          Questions about your data, or a request to see or delete it: <ContactAddress state={operator} /> More help is on
          the <TextLink href="/support">Support</TextLink> page and in the{' '}
          <TextLink href={guideLink(GUIDE_ANCHORS.start)}>User Guide</TextLink>.
        </P>
      </PolicySection>
    </PolicyPage>
  );
}
