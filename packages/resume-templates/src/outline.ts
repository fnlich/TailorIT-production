import type { InlineRun, ResumeDocument } from '@tailorit/shared';
import { resumeView, type EntryView, type ResumeView, type SectionView } from './model/view';

// A resume as plain lines, for the Word and TXT downloads: exactly what the page prints (the static view: hidden
// fields, empty fields and switched-off sections are not in it), as words only, in reading order: the header, then the
// main column, then the side column. Word gets the same lines as simple paragraphs; TXT joins them.

export type OutlineLineKind = 'name' | 'title' | 'contact' | 'heading' | 'entryTitle' | 'entrySubtitle' | 'meta' | 'text' | 'bullet';

export interface OutlineLine {
  kind: OutlineLineKind;
  text: string;
}

export interface ResumeOutline {
  /** The name, the headline and the contact line. */
  header: OutlineLine[];
  /** One block per section, its heading first. */
  sections: OutlineLine[][];
  /** The heading text as printed (capitals when the design says so). */
  uppercaseHeadings: boolean;
}

const words = (runs: readonly InlineRun[]) => runs.map((run) => run.text).join('').replace(/\s+/g, ' ').trim();
const line = (kind: OutlineLineKind, text: string): OutlineLine[] => (text.trim() ? [{ kind, text: text.trim() }] : []);
const joined = (parts: Array<string | null | undefined>, separator = ' | ') =>
  parts.map((part) => part?.trim() ?? '').filter(Boolean).join(separator);

function entryLines(entry: EntryView): OutlineLine[] {
  if (entry.level) {
    const level = entry.level.value ? `${entry.level.value}/5` : '';
    return line('text', joined([entry.title?.text, joined([entry.level.label?.text, level], ', ')], ': '));
  }
  return [
    ...line('entryTitle', entry.title?.text ?? ''),
    ...line('entrySubtitle', entry.subtitle?.text ?? ''),
    ...line(
      'meta',
      joined([
        entry.date?.text,
        entry.location?.text,
        entry.link?.text,
        ...entry.details.map((detail) => joined([detail.label, detail.text], ': ')),
      ]),
    ),
    ...line('text', entry.description ? words(entry.description.runs) : ''),
    ...entry.bullets.flatMap((bullet) => line('bullet', words(bullet.runs))),
  ];
}

function sectionLines(section: SectionView, uppercase: boolean): OutlineLine[] {
  const heading = uppercase ? section.heading.text.toUpperCase() : section.heading.text;
  const body = section.body;
  let content: OutlineLine[] = [];
  if (body.type === 'summary') content = line('text', words(body.text.runs));
  else if (body.type === 'chips') content = line('text', joined(body.chips.map((chip) => chip.text), ', '));
  else if (body.type === 'skills') {
    content = body.groups.flatMap((group) => {
      const skills = joined(group.skills.map((skill) => skill.text), ', ');
      return line('text', group.name?.text ? `${group.name.text}: ${skills}` : skills);
    });
  } else content = body.entries.flatMap(entryLines);
  return content.length > 0 ? [...line('heading', heading), ...content] : [];
}

export function viewOutline(view: ResumeView): ResumeOutline {
  const { header } = view;
  const uppercaseHeadings = view.design.uppercaseHeadings;
  const ordered = [
    ...view.sections.filter((section) => section.column === 'main'),
    ...view.sections.filter((section) => section.column === 'side'),
  ];
  return {
    header: [
      ...line('name', header.uppercaseName ? header.name.text.toUpperCase() : header.name.text),
      ...line('title', header.title?.text ?? ''),
      ...line('contact', joined(header.contacts.map((contact) => contact.text))),
    ],
    sections: ordered.map((section) => sectionLines(section, uppercaseHeadings)).filter((lines) => lines.length > 0),
    uppercaseHeadings,
  };
}

/** The outline of what a document prints. */
export function resumeOutline(document: ResumeDocument): ResumeOutline {
  return viewOutline(resumeView(document, 'static'));
}

/** The resume as a plain-text file: the header, then each section after a blank line; bullets as "- ". */
export function resumePlainText(document: ResumeDocument): string {
  const outline = resumeOutline(document);
  const text = (lines: OutlineLine[]) => lines.map((item) => (item.kind === 'bullet' ? `- ${item.text}` : item.text)).join('\n');
  return [text(outline.header), ...outline.sections.map(text)].filter(Boolean).join('\n\n') + '\n';
}
