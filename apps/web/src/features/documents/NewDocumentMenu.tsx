'use client';

import { EnvelopeSimpleIcon } from '@phosphor-icons/react/EnvelopeSimple';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { CaretDownIcon, CirclesFourIcon, FileTextIcon, PlusIcon } from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuTrigger } from '@/components/ui/Menu';
import { usePublicConstants, type PublicMessageKey } from '@/lib/constants';
import { NEW_RESUME_HREF } from '../resume-editor/api';
import type { DocumentKind } from './core/types';
import { useResumeLimitGate, type ResumeLimitGate } from './resumes/resumeLimit';

interface NewDocument {
  kind: DocumentKind;
  label: PublicMessageKey;
  hint: PublicMessageKey;
  href: string;
  icon: ReactNode;
}

/** v31 FIX-DOCS: what New makes, in the sections' order (each word a constant). */
export const NEW_DOCUMENTS: readonly NewDocument[] = [
  { kind: 'resume', label: 'LABEL_DOCS_NEW_RESUME', hint: 'LABEL_DOCS_NEW_RESUME_HINT', href: NEW_RESUME_HREF, icon: <FileTextIcon size={18} /> },
  {
    kind: 'cover-letter',
    label: 'LABEL_DOCS_NEW_LETTER',
    hint: 'LABEL_DOCS_NEW_LETTER_HINT',
    href: '/cover-letter/new',
    icon: <EnvelopeSimpleIcon size={18} />,
  },
  {
    kind: 'template',
    label: 'LABEL_DOCS_NEW_TEMPLATE',
    hint: 'LABEL_DOCS_NEW_TEMPLATE_HINT',
    href: '/cover-letter-template/new',
    icon: <CirclesFourIcon size={18} />,
  },
];

/**
 * v31 FIX-DOCS: the page header's New ⌄ (the page's main action): a menu of Resume, Cover letter and Letter template,
 * each with a one-line hint, opening its editor. At the Free resume limit, Resume says why instead (the limit's
 * dialog). `data-new-menu` is where focus lands when the last document of a section is deleted and nothing else is
 * left to focus. `checkLimit={false}` (the dev kit, which runs without the API) leaves the account unread.
 */
export function NewDocumentMenu({ checkLimit = true }: { checkLimit?: boolean }) {
  return checkLimit ? <GatedNewDocumentMenu /> : <NewDocumentMenuView gate={null} />;
}

function GatedNewDocumentMenu() {
  return <NewDocumentMenuView gate={useResumeLimitGate()} />;
}

function NewDocumentMenuView({ gate }: { gate: ResumeLimitGate | null }) {
  const { t } = usePublicConstants();
  const resumeGate = gate;
  return (
    <>
      <Menu>
        <MenuTrigger
          data-new-menu=""
          render={
            <Button
              icon={<PlusIcon size={16} weight="bold" />}
              trailingIcon={<CaretDownIcon size={14} className="-mr-0.5 transition-transform duration-150 in-data-popup-open:rotate-180" />}
            />
          }
        >
          {t('LABEL_DOCS_NEW')}
        </MenuTrigger>
        <MenuContent align="end" width="w-72" aria-label={t('LABEL_DOCS_NEW')}>
          {NEW_DOCUMENTS.map((item) => {
            const icon = <span className="flex size-8 items-center justify-center rounded-control bg-primary-soft text-primary">{item.icon}</span>;
            // v20 P8: at the resume limit, New › Resume shows the limit instead of opening the editor.
            if (item.kind === 'resume' && resumeGate?.info) {
              return (
                <MenuItem key={item.kind} icon={icon} hint={t(item.hint)} onClick={() => resumeGate.blocks()} className="py-2">
                  {t(item.label)}
                </MenuItem>
              );
            }
            return (
              <MenuLinkItem
                key={item.kind}
                href={item.href}
                render={<Link href={item.href} />}
                icon={icon}
                hint={t(item.hint)}
                className="py-2"
              >
                {t(item.label)}
              </MenuLinkItem>
            );
          })}
        </MenuContent>
      </Menu>
      {resumeGate?.dialog}
    </>
  );
}
