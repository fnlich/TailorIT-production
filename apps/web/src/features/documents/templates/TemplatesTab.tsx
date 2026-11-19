'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { LetterTemplateSummary } from '@tailorit/shared/letters';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { CirclesFourIcon, PlusIcon, TrashIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import {
  bulkDeleteTemplates,
  deleteTemplate,
  duplicateTemplate,
  fetchTemplates,
  templateKeys,
  uploadTemplate,
} from '../../letter-editor/data';
import { CopyIcon } from '../../letter-editor/icons';
import { useLetterUpload } from '../../letter-editor/UploadButton';
import { useRegisterUpload } from '../headerUpload'; // v31 FIX-DOCS
import { usePublicConstants } from '@/lib/constants';
import {
  DocumentCollection,
  DocumentNameCell,
  TableRowActions,
  TextCell,
  deleteOneWords,
  type ActionMenuItem,
  type DocumentColumn,
} from '../core';

/*
 * Documents › Templates (a table, list only): Name + "Built in" badge + an 80-character preview of the body, Created,
 * Edited, ✎ and ⋮ (Duplicate, Delete). TailorIT's starter templates come first; they cannot be selected or deleted,
 * only opened (read-only) and duplicated. v31 FIX-DOCS: the page header's Upload uploads a template here; the words
 * are the constants'.
 */

const NOUN = { one: 'template', many: 'templates' };

export function TemplatesTab() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const { t } = usePublicConstants();
  const query = useQuery({ queryKey: templateKeys.all, queryFn: fetchTemplates });
  const templates = query.data?.items ?? [];
  const [deleting, setDeleting] = useState<LetterTemplateSummary | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: templateKeys.all });
  // v31 FIX-DOCS: the page header's Upload: a template file, opened in the editor once read.
  const templateUpload = useLetterUpload({
    upload: uploadTemplate,
    onUploaded: (template) => {
      void refresh();
      router.push(`/cover-letter-template/${template.id}`);
    },
  });
  useRegisterUpload('templates', templateUpload.open, templateUpload.busy);

  const duplicate = async (template: LetterTemplateSummary) => {
    try {
      const copy = await duplicateTemplate(template.id);
      await refresh();
      toast.success(`Duplicated as "${copy.name}"`);
    } catch (error) {
      toast.error('Could not duplicate the template', userMessage(error));
    }
  };

  const menu = (template: LetterTemplateSummary): ActionMenuItem[] => [
    { key: 'duplicate', label: 'Duplicate', icon: <CopyIcon size={16} />, onSelect: () => void duplicate(template) },
    {
      key: 'delete',
      label: 'Delete',
      icon: <TrashIcon size={16} />,
      tone: 'danger',
      ruleBefore: true,
      disabled: template.isSystem,
      title: template.isSystem ? t('MSG_DOCS_TEMPLATE_BUILT_IN_KEPT') : undefined,
      onSelect: () => setDeleting(template),
    },
  ];

  const columns: DocumentColumn<LetterTemplateSummary>[] = [
    {
      key: 'name',
      header: 'Name',
      track: 'minmax(0,1.06fr)',
      cell: (template) => (
        <DocumentNameCell
          name={template.name}
          href={`/cover-letter-template/${template.id}`}
          badges={template.isSystem ? <Badge tone="tint">{t('LABEL_DOCS_TEMPLATE_BUILT_IN')}</Badge> : undefined}
          preview={template.preview || undefined}
        />
      ),
    },
    {
      key: 'created',
      header: 'Created',
      track: 'minmax(0,1fr)',
      cell: (template) => <TextCell>{relativeTime(template.createdAt, now)}</TextCell>,
    },
    {
      key: 'edited',
      header: 'Edited',
      track: 'minmax(0,0.97fr)',
      cell: (template) => <TextCell>{relativeTime(template.lastEditedAt, now)}</TextCell>,
    },
  ];

  return (
    <>
      <DocumentCollection<LetterTemplateSummary>
        kind="template"
        noun={NOUN}
        items={templates}
        getId={(template) => template.id}
        getLabel={(template) => template.name}
        searchFields={(template) => [template.name]}
        searchPlaceholder="Search templates"
        columns={columns}
        renderActions={(template) => (
          <TableRowActions label={template.name} editHref={`/cover-letter-template/${template.id}`} menuItems={menu(template)} />
        )}
        selectable
        isSelectable={(template) => !template.isSystem}
        bulkDeleteNote={(selected) => {
          const system = selected.filter((template) => template.isSystem).length;
          return system ? t('MSG_DOCS_TEMPLATES_SKIPPED', { count: system }) : null;
        }}
        onBulkDelete={async (ids) => {
          const { deleted } = await bulkDeleteTemplates(ids);
          await refresh();
          toast.success(`Deleted ${deleted} ${deleted === 1 ? 'template' : 'templates'}`);
        }}
        loading={query.isPending}
        error={
          query.isError ? (
            <Notice
              tone="error"
              title="Your templates didn't load."
              action={
                <Button variant="outline" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
                  Try again
                </Button>
              }
            >
              {userMessage(query.error, 'Please try again in a moment.')}
            </Notice>
          ) : undefined
        }
        empty={{
          // v31 FIX-DOCS (REQ-3): the constants' words.
          title: t('MSG_DOCS_TEMPLATES_EMPTY_TITLE'),
          description: t('MSG_DOCS_TEMPLATES_EMPTY_TEXT'),
          icon: <CirclesFourIcon size={24} />,
          action: (
            <Link href="/cover-letter-template/new" className={buttonClasses()} data-new-fallback="template">
              <PlusIcon size={16} />
              New template
            </Link>
          ),
        }}
      />

      {templateUpload.input}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        {...deleteOneWords(deleting?.name ?? '', NOUN, t)}
        confirmLabel="Delete"
        busyLabel="Deleting..."
        onConfirm={async () => {
          if (!deleting) return;
          await deleteTemplate(deleting.id);
          await refresh();
        }}
      />
    </>
  );
}
