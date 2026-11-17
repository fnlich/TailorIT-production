import { registrableDomain } from '../domain';
import { tokenize, type HtmlTag, type HtmlToken } from './html';

// v30 E2: what one page of a company's own website says about the company (docs/design/part2/13-company-enrichment.md
// §3.3): its schema.org Organization (JSON-LD, or microdata), its meta description and site name, its icons and its
// og:image, its links to the company's LinkedIn page and other profiles, and its "about" link. The page is read as
// text only. A page that asks not to be quoted (`<meta name="robots" content="nosnippet">` or a max-snippet limit)
// gives no description: it is neither shown verbatim nor used as AI input (13 §3.3).

/** The schema.org types that are an organisation (Organization and its common subtypes). */
const ORGANIZATION_TYPES = new Set([
  'organization',
  'corporation',
  'ngo',
  'educationalorganization',
  'collegeoruniversity',
  'governmentorganization',
  'medicalorganization',
  'newsmediaorganization',
  'onlinebusiness',
  'onlinestore',
  'localbusiness',
  'professionalservice',
  'sportsorganization',
  'airline',
  'consortium',
  'researchorganization',
  'workersunion',
  'fundingscheme',
  'performinggroup',
  'library',
]);

/** A schema.org node as JSON-LD gives it (or as the microdata reader builds it). */
type Node = Record<string, unknown>;

export interface OrganizationFacts {
  name: string | null;
  legalName: string | null;
  url: string | null;
  logo: string | null;
  sameAs: string[];
  description: string | null;
  foundingDate: string | null;
  /** numberOfEmployees: a count, or a range's bounds. */
  employees: number | null;
  employeesMin: number | null;
  employeesMax: number | null;
  address: { locality: string | null; region: string | null; country: string | null } | null;
  leiCode: string | null;
  naics: string | null;
  parentName: string | null;
  parentUrl: string | null;
}

export type LogoSource = 'organization' | 'touch_icon' | 'icon' | 'og_image';

export interface LogoCandidate {
  url: string;
  from: LogoSource;
  /** The size the page declares (its `sizes`), in px; null when it says none. */
  declared: number | null;
  /** The page says it is an SVG (`type="image/svg+xml"`, `sizes="any"`, a .svg address). */
  vector: boolean;
}

export interface SitePage {
  organization: OrganizationFacts | null;
  /** og:site_name. */
  siteName: string | null;
  /** The Organization's description, else the meta description, else og:description; null under nosnippet. */
  description: string | null;
  /** The page asked not to be quoted. */
  nosnippet: boolean;
  /** Links to the company's profiles: LinkedIn company pages among them (kept as addresses; never requested). */
  profileLinks: string[];
  /**
   * Logo candidates, best first (13 §6.1: Organization.logo, the touch icon, a large or vector icon, an icon of unknown
   * size, og:image last). A web app manifest's icons are not read: the shared reader reads pages and images only.
   */
  logos: LogoCandidate[];
  /** A link to the site's "about" page on the same registrable domain. */
  aboutUrl: string | null;
  /**
   * v30 INT-4 (S2's edit C, 12 §4.1 signal 4): the site's "Careers" link: a careers path on its own registrable domain,
   * or a link named Careers or Jobs anywhere (often the company's ATS board). Never read here: discovery is offered it.
   */
  careersUrl: string | null;
}

/** The profile sites whose links a company's page may give (never requested; only kept as links). */
const PROFILE_HOSTS = /(?:^|\.)(?:linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|github\.com|tiktok\.com)$/i;
/** Share and intent links are no profile. */
const NOT_A_PROFILE = /\/(?:share|sharer|intent|dialog|shareArticle|sharing)\b|[?&](?:u|url|text)=/i;
const ABOUT_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:about(?:-us)?|company|who-we-are|our-story|about\/(?:us|company))\/?$/i;
const ABOUT_TEXT = /^\s*about(?:\s+us)?\s*$/i;
const CAREERS_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:careers?|jobs|join(?:-us)?|work-with-us|open-positions|vacancies)\/?$/i;
const CAREERS_TEXT = /^\s*(?:careers?|jobs|join us|work with us|open positions|we(?:'|’)re hiring|vacancies)\s*$/i;

/** An http(s) address resolved against the page; null for anything else. */
export function absoluteUrl(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** A text value of a schema.org property (a string, the first of a list, or a {"@value"}). */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textOf(item);
      if (text) return text;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const record = value as Node;
    return textOf(record['@value'] ?? record.name ?? null);
  }
  return null;
}

/** An address value: a string, an ImageObject's url or contentUrl, or a reference's @id. */
function urlValueOf(value: unknown, base: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = urlValueOf(item, base);
      if (url) return url;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const record = value as Node;
    return urlValueOf(record.url ?? record.contentUrl ?? record['@id'] ?? null, base);
  }
  return absoluteUrl(value, base);
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function numberOf(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : textOf(value);
  if (!text) return null;
  const number = Number(text.replace(/[,\s]/g, ''));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function typesOf(node: Node): string[] {
  return listOf(node['@type']).map((type) => String(type).replace(/^.*[/#]/, '').toLowerCase());
}

const isOrganization = (node: Node) => typesOf(node).some((type) => ORGANIZATION_TYPES.has(type));

/** Every object in a JSON-LD value (its @graph, lists and nested objects), at most a few hundred. */
function nodesOf(value: unknown, out: Node[] = [], depth = 0): Node[] {
  if (depth > 8 || out.length > 500) return out;
  if (Array.isArray(value)) {
    for (const item of value) nodesOf(item, out, depth + 1);
  } else if (value && typeof value === 'object') {
    const node = value as Node;
    out.push(node);
    for (const child of Object.values(node)) if (child && typeof child === 'object') nodesOf(child, out, depth + 1);
  }
  return out;
}

/** A JSON-LD block's value (wrapped in a comment or CDATA as some sites write it); null when it is not JSON. */
function jsonOf(content: string): unknown {
  const text = content.trim().replace(/^<!--|-->$/g, '').replace(/^\/\/\s*<!\[CDATA\[|\/\/\s*\]\]>$/g, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A node with its @id references to other nodes followed once (WebSite.publisher -> the Organization). */
function resolved(node: Node, ids: ReadonlyMap<string, Node>): Node {
  const out: Node = { ...node };
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const id = (value as Node)['@id'];
      if (typeof id === 'string' && Object.keys(value).length === 1 && ids.has(id)) out[key] = ids.get(id);
    }
  }
  return out;
}

/** An Organization node's facts. */
export function organizationFacts(node: Node, base: string): OrganizationFacts {
  const address = listOf(node.address)[0];
  const place =
    typeof address === 'string'
      ? { locality: address.trim() || null, region: null, country: null }
      : address && typeof address === 'object'
        ? {
            locality: textOf((address as Node).addressLocality),
            region: textOf((address as Node).addressRegion),
            country: textOf((address as Node).addressCountry),
          }
        : null;
  const staff = listOf(node.numberOfEmployees)[0];
  const range = staff && typeof staff === 'object' && !Array.isArray(staff) ? (staff as Node) : null;
  const parent = listOf(node.parentOrganization)[0];
  return {
    name: textOf(node.name),
    legalName: textOf(node.legalName),
    url: urlValueOf(node.url, base),
    logo: urlValueOf(node.logo, base) ?? urlValueOf(node.image, base),
    sameAs: listOf(node.sameAs)
      .map((item) => absoluteUrl(typeof item === 'string' ? item : textOf(item), base))
      .filter((url): url is string => url !== null),
    description: textOf(node.description),
    foundingDate: textOf(node.foundingDate),
    employees: range ? numberOf(range.value) : numberOf(staff),
    employeesMin: range ? numberOf(range.minValue) : null,
    employeesMax: range ? numberOf(range.maxValue) : null,
    address: place && (place.locality || place.region || place.country) ? place : null,
    leiCode: textOf(node.leiCode),
    naics: textOf(node.naics),
    parentName: parent && typeof parent === 'object' ? textOf((parent as Node).name) : textOf(parent),
    parentUrl: parent && typeof parent === 'object' ? urlValueOf((parent as Node).url ?? (parent as Node).sameAs, base) : null,
  };
}

/** How many facts an Organization gives (the fuller one wins when a page has several). */
function weight(facts: OrganizationFacts): number {
  return Object.values(facts).filter((value) => value !== null && !(Array.isArray(value) && value.length === 0)).length;
}

/**
 * The page's Organization: the one whose address (url, sameAs, @id) is on the page's registrable domain first, then the
 * one with the most facts.
 */
function chooseOrganization(nodes: readonly Node[], base: string): OrganizationFacts | null {
  const domain = registrableDomain(base);
  let best: { facts: OrganizationFacts; score: number } | null = null;
  for (const node of nodes) {
    const facts = organizationFacts(node, base);
    const own = [facts.url, typeof node['@id'] === 'string' ? absoluteUrl(node['@id'], base) : null].some(
      (url) => url !== null && registrableDomain(url) === domain,
    );
    const score = (own ? 100 : 0) + weight(facts);
    if (!best || score > best.score) best = { facts, score };
  }
  return best?.facts ?? null;
}

// ── Microdata ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Scope {
  node: Node;
  depth: number;
}

/** The value of an element's itemprop that is not a scope (13 §3.3: content, href, src, datetime, value). */
function propValueOf(tag: HtmlTag): string | null {
  const attrs = tag.attrs;
  if (attrs.content !== undefined) return attrs.content;
  if (['a', 'link', 'area'].includes(tag.name)) return attrs.href ?? null;
  if (['img', 'audio', 'embed', 'iframe', 'source', 'track', 'video'].includes(tag.name)) return attrs.src ?? null;
  if (tag.name === 'time') return attrs.datetime ?? null;
  if (tag.name === 'data' || tag.name === 'meter') return attrs.value ?? null;
  return null;
}

function addProp(node: Node, names: string, value: unknown): void {
  for (const name of names.split(/\s+/).filter(Boolean)) {
    const before = node[name];
    node[name] = before === undefined ? value : [...listOf(before), value];
  }
}

/** The microdata items of a page, as JSON-LD-like nodes (nested items as nested nodes). Best effort: tags not closed. */
function microdataNodes(tokens: readonly HtmlToken[]): Node[] {
  const tops: Node[] = [];
  const scopes: Scope[] = [];
  const texts: Array<{ node: Node; names: string; depth: number; text: string }> = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.type === 'text') {
      for (const pending of texts) pending.text += token.text;
    } else if (token.type === 'open') {
      const { tag } = token;
      if (!tag.selfClosing) depth += 1;
      const current = scopes.at(-1);
      const names = tag.attrs.itemprop;
      if (tag.attrs.itemscope !== undefined) {
        const node: Node = { '@type': (tag.attrs.itemtype ?? '').split(/\s+/).filter(Boolean) };
        if (names && current) addProp(current.node, names, node);
        else tops.push(node);
        if (!tag.selfClosing) scopes.push({ node, depth });
      } else if (names && current) {
        const value = propValueOf(tag);
        if (value !== null) addProp(current.node, names, value);
        else if (!tag.selfClosing) texts.push({ node: current.node, names, depth, text: '' });
      }
    } else if (token.type === 'close') {
      while (texts.length > 0 && texts.at(-1)!.depth >= depth) {
        const done = texts.pop()!;
        addProp(done.node, done.names, done.text.replace(/\s+/g, ' ').trim());
      }
      while (scopes.length > 0 && scopes.at(-1)!.depth >= depth) scopes.pop();
      depth = Math.max(0, depth - 1);
    }
  }
  return tops.flatMap((node) => nodesOf(node));
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function sizeOf(sizes: string | undefined): { px: number | null; any: boolean } {
  if (!sizes) return { px: null, any: false };
  if (/\bany\b/i.test(sizes)) return { px: null, any: true };
  const all = [...sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)].map((match) => Math.min(Number(match[1]), Number(match[2])));
  return { px: all.length > 0 ? Math.max(...all) : null, any: false };
}

const RANK: Record<LogoSource, number> = { organization: 0, touch_icon: 1, icon: 2, og_image: 4 };

/** A page's facts about its company (see the module's note). `pageUrl` is the address the page was read from. */
export function parseSitePage(html: string, pageUrl: string): SitePage {
  const tokens = tokenize(html);
  const meta = new Map<string, string>();
  const icons: Array<LogoCandidate & { rank: number }> = [];
  const anchors: Array<{ href: string; text: string }> = [];
  const ldNodes: Node[] = [];
  let base = pageUrl;
  let anchor: { href: string; text: string } | null = null;
  for (const token of tokens) {
    if (token.type === 'raw') {
      if (token.tag.name === 'script' && /ld\+json/i.test(token.tag.attrs.type ?? '')) ldNodes.push(...nodesOf(jsonOf(token.content)));
      continue;
    }
    if (token.type === 'text') {
      if (anchor) anchor.text += token.text;
      continue;
    }
    if (token.type === 'close') {
      if (token.name === 'a' && anchor) {
        anchors.push(anchor);
        anchor = null;
      }
      continue;
    }
    const { tag } = token;
    if (tag.name === 'base' && tag.attrs.href) base = absoluteUrl(tag.attrs.href, pageUrl) ?? base;
    else if (tag.name === 'meta') {
      const key = (tag.attrs.name ?? tag.attrs.property ?? '').trim().toLowerCase();
      if (key && tag.attrs.content !== undefined && !meta.has(key)) meta.set(key, tag.attrs.content.trim());
    } else if (tag.name === 'link' && tag.attrs.href) {
      const rel = (tag.attrs.rel ?? '').toLowerCase().split(/\s+/);
      const href = absoluteUrl(tag.attrs.href, base);
      if (!href) continue;
      const touch = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
      if (!touch && !rel.includes('icon')) continue;
      const size = sizeOf(tag.attrs.sizes);
      const vector = size.any || /svg/i.test(tag.attrs.type ?? '') || /\.svg(?:$|[?#])/i.test(href);
      icons.push({
        url: href,
        from: touch ? 'touch_icon' : 'icon',
        declared: size.px,
        vector,
        // An icon of unknown size ranks after the large ones: a favicon is usually 16 or 32 px.
        rank: touch ? RANK.touch_icon : vector || (size.px ?? 0) >= 64 ? RANK.icon : RANK.icon + 1,
      });
    } else if (tag.name === 'a' && tag.attrs.href) {
      const href = absoluteUrl(tag.attrs.href, base);
      anchor = href ? { href, text: '' } : null;
    }
  }

  const ids = new Map<string, Node>();
  for (const node of ldNodes) if (typeof node['@id'] === 'string') ids.set(node['@id'], node);
  const organizations = [...ldNodes.map((node) => resolved(node, ids)), ...microdataNodes(tokens)].filter(isOrganization);
  const organization = chooseOrganization(organizations, base);

  const robots = [meta.get('robots'), meta.get('tailorit')].filter(Boolean).join(',').toLowerCase();
  const snippet = /max-snippet\s*:\s*(-?\d+)/.exec(robots);
  const nosnippet = /\bnosnippet\b/.test(robots) || (snippet !== null && Number(snippet[1]) >= 0);
  const description = nosnippet ? null : (organization?.description ?? meta.get('description') ?? meta.get('og:description') ?? null) || null;

  const logos: Array<LogoCandidate & { rank: number }> = [...icons];
  if (organization?.logo) logos.push({ url: organization.logo, from: 'organization', declared: null, vector: /\.svg(?:$|[?#])/i.test(organization.logo), rank: RANK.organization });
  const ogImage = absoluteUrl(meta.get('og:image') ?? meta.get('og:image:url'), base);
  if (ogImage) logos.push({ url: ogImage, from: 'og_image', declared: null, vector: false, rank: RANK.og_image });
  logos.sort((a, b) => a.rank - b.rank || (b.vector ? 1 : 0) - (a.vector ? 1 : 0) || (b.declared ?? 0) - (a.declared ?? 0));
  const seen = new Set<string>();
  const ranked = logos.filter((logo) => !seen.has(logo.url) && seen.add(logo.url)).map(({ rank: _rank, ...logo }) => logo);

  const domain = registrableDomain(base);
  const profileLinks: string[] = [];
  for (const link of [...(organization?.sameAs ?? []), ...anchors.map((a) => a.href)]) {
    let host = '';
    try {
      host = new URL(link).hostname;
    } catch {
      continue;
    }
    if (PROFILE_HOSTS.test(host) && !NOT_A_PROFILE.test(link) && !profileLinks.includes(link) && profileLinks.length < 20) profileLinks.push(link);
  }
  const about = anchors.find((a) => {
    try {
      const url = new URL(a.href);
      return registrableDomain(url.hostname) === domain && url.href !== pageUrl && (ABOUT_PATH.test(url.pathname) || ABOUT_TEXT.test(a.text));
    } catch {
      return false;
    }
  });

  const careers = anchors.find((a) => {
    try {
      const url = new URL(a.href);
      if (url.href === pageUrl || (url.protocol !== 'https:' && url.protocol !== 'http:')) return false;
      return (registrableDomain(url.hostname) === domain && CAREERS_PATH.test(url.pathname)) || CAREERS_TEXT.test(a.text);
    } catch {
      return false;
    }
  });

  return {
    organization,
    siteName: meta.get('og:site_name') || null,
    description,
    nosnippet,
    profileLinks,
    logos: ranked,
    aboutUrl: about?.href ?? null,
    careersUrl: careers?.href ?? null,
  };
}
