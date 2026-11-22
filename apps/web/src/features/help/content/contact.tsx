'use client';

import { DELETE_COPY } from '../../account-deletion/copy';
import { ACCOUNT_COPY } from '../../settings/account';
import { useGuide } from '../context';
import type { GuideSection } from '../model';
import { Bullets, P, PublicLink, Ui } from '../parts';
import { LifebuoyIcon } from '../icons';

// v34 HELP (PLAN G6, G8): contact, privacy and terms: the public pages PUBLIC builds (/support, /privacy, /terms) and
// the admin's contact address (ADMIN_CONTACT_EMAIL, a public constant).

function Contact() {
  const { get } = useGuide();
  const email = get('ADMIN_CONTACT_EMAIL');
  return (
    <>
      <Bullets>
        <li>
          <PublicLink href="/support">Support</PublicLink>: how to reach TailorIT&apos;s support, and checks for common
          problems, connecting your AI included.
        </li>
        {/* v34 FIX-COPY (final review G-L7): since ACCTDEL you delete your account yourself. */}
        <li>
          <PublicLink href="/privacy">Privacy policy</PublicLink>: what TailorIT keeps about you, why, who processes it, how
          long it is kept and how to delete it (Settings › {ACCOUNT_COPY.title} › {DELETE_COPY.openSelf}).
        </li>
        <li>
          <PublicLink href="/terms">Terms of use</PublicLink>.
        </li>
      </Bullets>
      <P>
        {email ? (
          <>
            TailorIT&apos;s admin: <Ui>{email}</Ui>.
          </>
        ) : (
          "The support page says how to reach TailorIT's admin."
        )}
      </P>
    </>
  );
}

export const CONTACT_SECTION: GuideSection = {
  id: 'contact',
  title: 'Contact, privacy and terms',
  icon: LifebuoyIcon,
  keywords: ['contact', 'support', 'privacy', 'terms', 'help'],
  topics: [{ id: 'contact-links', title: 'Support, privacy and terms', keywords: ['email', 'admin'], Body: Contact }],
};
