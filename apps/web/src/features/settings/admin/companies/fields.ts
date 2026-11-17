import {
  COMPANY_FOUNDED_KINDS,
  COMPANY_FOUNDED_LABEL,
  COMPANY_FOUNDED_YEAR_MAX,
  COMPANY_FOUNDED_YEAR_MIN,
  COMPANY_MATCH_REVIEW_KIND_LABEL,
  COMPANY_PROFILE_FIELDS,
  COMPANY_SIZES,
  COMPANY_STAGE_LABEL,
  COMPANY_STAGES,
  COMPANY_SUMMARY_MAX,
  COMPANY_TAGLINE_MAX,
  CompanyProfileInputSchema,
  INDUSTRIES,
  NOT_SPECIFIED_INDUSTRY,
  industryLabel,
  type CompanyMatchReviewKind,
  type CompanyProfileField,
  type CompanyProfileInput,
  type CompanySourceKind,
} from '@tailorit/shared';
import type { TooLongText } from '@/lib/constants';

// v30 E0-WEB: the company editor's fields (13-company-enrichment.md §6.4: each with its value, source, confidence and
// the other candidates; an admin's value is locked). One spec per COMPANY_PROFILE_FIELDS id says how it is written and
// read; parseFieldDraft turns what the admin typed into the value CompanyProfileInputSchema takes.

export type FieldKind = 'text' | 'textarea' | 'url' | 'int' | 'enum' | 'bool' | 'links';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldSpec {
  field: CompanyProfileField;
  label: string;
  kind: FieldKind;
  /** The text kinds' length cap (the schema's). */
  max?: number;
  options?: readonly FieldOption[];
  /** A line under the input. */
  hint?: string;
  /** The editor's group. */
  group: 'identity' | 'about' | 'links' | 'facts';
}

const text = (field: CompanyProfileField, label: string, max: number, group: FieldSpec['group'], hint?: string): FieldSpec => ({
  field,
  label,
  kind: 'text',
  max,
  group,
  ...(hint ? { hint } : {}),
});

const INDUSTRY_OPTIONS: FieldOption[] = [
  ...INDUSTRIES.map((industry) => ({ value: industry.id as string, label: industry.label as string })),
  { value: NOT_SPECIFIED_INDUSTRY, label: industryLabel(NOT_SPECIFIED_INDUSTRY) },
];

/** Every profile field, in the editor's order. */
export const FIELD_SPECS: Readonly<Record<CompanyProfileField, FieldSpec>> = {
  displayName: text('displayName', 'Name people know', 300, 'identity'),
  legalName: text('legalName', 'Legal name', 300, 'identity'),
  logoUrl: text('logoUrl', 'Logo', 2048, 'identity', "A path to TailorIT's stored copy, starting with /. Never a remote address."),
  tagline: text('tagline', 'Tagline', COMPANY_TAGLINE_MAX, 'about'),
  summary: { field: 'summary', label: 'Description', kind: 'textarea', max: COMPANY_SUMMARY_MAX, group: 'about', hint: "An admin's description is shown with no origin line." },
  industry: { field: 'industry', label: 'Industry', kind: 'enum', options: INDUSTRY_OPTIONS, group: 'facts' },
  industryDetail: text('industryDetail', "Industry in the source's words", 200, 'facts'),
  website: { field: 'website', label: 'Website', kind: 'url', max: 2048, group: 'links', hint: 'An https:// address.' },
  domain: text('domain', 'Domain', 253, 'links', 'The registrable domain, such as acme.com.'),
  linkedinUrl: {
    field: 'linkedinUrl',
    label: 'LinkedIn page',
    kind: 'url',
    max: 2048,
    group: 'links',
    hint: 'Only a page an allowed source names (https://www.linkedin.com/company/…). TailorIT never reads LinkedIn.',
  },
  otherLinks: { field: 'otherLinks', label: 'Other links', kind: 'links', group: 'links', hint: 'One a line: a label, a bar, then the address (Careers | https://…).' },
  employees: { field: 'employees', label: 'Employees', kind: 'int', group: 'facts' },
  sizeBucket: {
    field: 'sizeBucket',
    label: 'Company size',
    kind: 'enum',
    options: COMPANY_SIZES.map((size) => ({ value: size.id as string, label: `${size.label} employees` })),
    group: 'facts',
  },
  stage: { field: 'stage', label: 'Company stage', kind: 'enum', options: COMPANY_STAGES.map((stage) => ({ value: stage, label: COMPANY_STAGE_LABEL[stage] })), group: 'facts' },
  ticker: text('ticker', 'Ticker', 20, 'facts'),
  exchange: text('exchange', 'Exchange', 40, 'facts'),
  hqCity: text('hqCity', 'Headquarters city', 120, 'facts'),
  hqRegion: text('hqRegion', 'Headquarters region', 120, 'facts'),
  hqCountryCode: text('hqCountryCode', 'Headquarters country', 2, 'facts', 'Two capital letters, such as US.'),
  foundedYear: { field: 'foundedYear', label: 'Year', kind: 'int', group: 'facts', hint: `From ${COMPANY_FOUNDED_YEAR_MIN} to ${COMPANY_FOUNDED_YEAR_MAX}.` },
  foundedKind: {
    field: 'foundedKind',
    label: 'Founded or incorporated',
    kind: 'enum',
    options: COMPANY_FOUNDED_KINDS.map((kind) => ({ value: kind, label: COMPANY_FOUNDED_LABEL[kind] })),
    group: 'facts',
  },
  fundingTotalUsd: { field: 'fundingTotalUsd', label: 'Total funding (USD)', kind: 'int', group: 'facts', hint: 'Not shown to people: only a licensed source may give it.' },
  sponsorsH1b: { field: 'sponsorsH1b', label: 'Sponsors H-1B', kind: 'bool', group: 'facts' },
};

/** The groups of the editor, in order. */
export const FIELD_GROUPS: ReadonlyArray<{ id: FieldSpec['group']; title: string }> = [
  { id: 'identity', title: 'Name and logo' },
  { id: 'about', title: 'Description' },
  { id: 'links', title: 'Links' },
  { id: 'facts', title: 'Facts' },
];

/** The fields of a group, in COMPANY_PROFILE_FIELDS' order. */
export function fieldsOf(group: FieldSpec['group']): CompanyProfileField[] {
  return COMPANY_PROFILE_FIELDS.filter((field) => FIELD_SPECS[field].group === group);
}

/** A field's value as the editor shows it; '' for none. */
export function formatFieldValue(field: CompanyProfileField, value: unknown): string {
  if (value === null || value === undefined) return '';
  const spec = FIELD_SPECS[field];
  switch (spec.kind) {
    case 'bool':
      return value === true ? 'Yes' : value === false ? 'No' : '';
    case 'enum':
      return spec.options?.find((option) => option.value === value)?.label ?? String(value);
    case 'int':
      return typeof value === 'number' ? (field === 'foundedYear' ? String(value) : value.toLocaleString('en-US')) : String(value);
    case 'links':
      return Array.isArray(value)
        ? value
            .filter((link): link is { label: string; url: string } => typeof link === 'object' && link !== null && 'url' in link)
            .map((link) => (link.label ? `${link.label}: ${link.url}` : link.url))
            .join('\n')
        : '';
    default:
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

/** What the input starts with for a value. */
export function draftOf(field: CompanyProfileField, value: unknown): string {
  if (value === null || value === undefined) return '';
  const spec = FIELD_SPECS[field];
  if (spec.kind === 'bool') return value === true ? 'yes' : value === false ? 'no' : '';
  if (spec.kind === 'int') return typeof value === 'number' ? String(value) : '';
  if (spec.kind === 'links') {
    return Array.isArray(value)
      ? value
          .filter((link): link is { label: string; url: string } => typeof link === 'object' && link !== null && 'url' in link)
          .map((link) => `${link.label} | ${link.url}`)
          .join('\n')
      : '';
  }
  return typeof value === 'string' ? value : String(value);
}

/**
 * v30 FIX-WEB (REV-UX UX-5): whether an admin's draft changes the field: Save sends nothing for a draft that is the value
 * shown (an Edit then Save with no change, an empty field left empty), since a save locks the field against its sources.
 */
export function draftChanged(field: CompanyProfileField, value: unknown, draft: string): boolean {
  const norm = (text: string) => text.replace(/\r\n/g, '\n').trim();
  return norm(draft) !== norm(draftOf(field, value));
}

export type ParsedDraft = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * The value an admin's draft sets (an empty draft clears the field: null, or no links), checked by the shared input
 * schema, with the words a person reads when it is refused. `tooLong` is the page's MSG_TEXT_TOO_LONG.
 */
export function parseFieldDraft(field: CompanyProfileField, draft: string, tooLong: TooLongText): ParsedDraft {
  const spec = FIELD_SPECS[field];
  const raw = draft.trim();
  let value: unknown;
  if (spec.kind === 'links') {
    const links: Array<{ label: string; url: string }> = [];
    for (const line of raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      const bar = line.lastIndexOf('|');
      const label = bar >= 0 ? line.slice(0, bar).trim() : '';
      const url = (bar >= 0 ? line.slice(bar + 1) : line).trim();
      if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: `"${line}" has no http(s) address after its bar.` };
      links.push({ label, url });
    }
    value = links;
  } else if (raw === '') {
    value = null;
  } else if (spec.kind === 'int') {
    if (!/^\d+$/.test(raw.replace(/,/g, ''))) return { ok: false, error: 'Enter a whole number.' };
    value = Number(raw.replace(/,/g, ''));
  } else if (spec.kind === 'bool') {
    value = raw === 'yes';
  } else {
    if (spec.max !== undefined && raw.length > spec.max) return { ok: false, error: tooLong(spec.max) };
    value = field === 'hqCountryCode' ? raw.toUpperCase() : raw;
  }
  const checked = CompanyProfileInputSchema.shape[field].safeParse(value);
  if (checked.success) return { ok: true, value: checked.data };
  return { ok: false, error: refusalWords(field) };
}

/** The words for a value the shared schema refuses (lengths are caught before it). */
function refusalWords(field: CompanyProfileField): string {
  switch (field) {
    case 'website':
      return 'Enter an https:// address.';
    case 'linkedinUrl':
      return 'Enter a LinkedIn company page (https://www.linkedin.com/company/…).';
    case 'logoUrl':
      return 'Enter a path starting with / (TailorIT serves its own copy of each logo).';
    case 'hqCountryCode':
      return 'Enter a two-letter country code, such as US.';
    case 'foundedYear':
      return `Enter a year from ${COMPANY_FOUNDED_YEAR_MIN} to ${COMPANY_FOUNDED_YEAR_MAX}.`;
    case 'otherLinks':
      return 'Check the links: a label, a bar, then an address, one a line.';
    default:
      return 'That value cannot be used here.';
  }
}

/** The edit that sets one field (the server locks it): a PATCH body. */
export function setBody(field: CompanyProfileField, value: unknown): { set: CompanyProfileInput } {
  return { set: { [field]: value } as CompanyProfileInput };
}

/** Each source kind's name in the editor, where an admin tells a board from the company's own site. */
const SOURCE_KIND_NAME: Record<CompanySourceKind, string> = {
  ats_board: 'ATS board',
  job_posting: 'Job posting',
  company_site: "Company's website",
  wikidata: 'Wikidata',
  sec: 'SEC EDGAR',
  gleif: 'GLEIF',
  logo_dev: 'logo.dev',
  ai: 'AI',
  admin: 'Admin',
  legacy: 'Before v3.0',
};

/** A source kind's name in the editor ("ATS board", "Vendor: acme"); "None" for no source. */
export function sourceKindLabel(kind: string | null | undefined): string {
  if (!kind) return 'None';
  if (kind in SOURCE_KIND_NAME) return SOURCE_KIND_NAME[kind as CompanySourceKind];
  return kind.startsWith('vendor:') ? `Vendor: ${kind.slice('vendor:'.length)}` : kind;
}

/** A match review's kind in words ("Same company?"). */
export function reviewKindLabel(kind: CompanyMatchReviewKind): string {
  return COMPANY_MATCH_REVIEW_KIND_LABEL[kind];
}
