import {
  AUTOFILL_ANY_HOST,
  HostNameSchema,
  PutAutofillSignInBodySchema,
  type AutofillSignInItem,
  type PutAutofillSignInBody,
} from '@tailorit/shared/autofill';

// Settings › Autofill › Job-site sign-in, the part that is not React: how a sign-in's site reads, the site the person
// typed as a host name, and the body a save sends. The checks are the contract's own PUT schema, the one the server
// parses with. Nothing here keeps a password: the dialog reads it from its field at the save and passes it through.

/** Where a sign-in is used: every site, or one site the person names. */
export type SignInScope = 'any' | 'site';

/** What a save is made from. `password` '' means "keep the saved one" for a site that has one, else "not typed yet". */
export interface SignInForm {
  scope: SignInScope;
  /** The site as typed (a host name or a pasted address); read with `hostFromInput`. */
  site: string;
  email: string;
  password: string;
}

export type SignInProblems = Partial<Record<'site' | 'email' | 'password', string>>;

/** "All job sites" for the sign-in used everywhere, else its host name. */
export function hostLabel(host: string): string {
  return host === AUTOFILL_ANY_HOST ? 'All job sites' : host;
}

/**
 * The sites the sign-in for every site is used on, in words: the candidate sign-in pages signInHostCovered allows under
 * AUTOFILL_SIGN_IN_HOST_SUFFIXES (a company's Workday, iCIMS or Taleo site, the SuccessFactors career sites, an Oracle
 * Recruiting tenant on either cloud, SmartRecruiters' jobs and careers sites, and since autofill API 6 UltiPro's
 * recruiting site and ClearCompany's and ADP Workforce Now's application pages, and since API 7 Paycom's), never
 * those domains' other hosts or an employer's employee pages.
 */
export const EVERY_SITE_COVERS =
  'the sign-in pages of Workday, iCIMS, Taleo, SuccessFactors career sites, Oracle Recruiting, SmartRecruiters and ' +
  'UltiPro, and the application pages of ClearCompany, ADP Workforce Now and Paycom';

/** "Last used on acme.wd5.myworkdayjobs.com 2 hours ago", or "Not used yet". */
export function lastReadLine(
  item: Pick<AutofillSignInItem, 'lastReadHost' | 'lastReadAt'>,
  ago: (iso: string) => string,
): string {
  if (!item.lastReadAt) return 'Not used yet';
  return `Last used${item.lastReadHost ? ` on ${item.lastReadHost}` : ''} ${ago(item.lastReadAt)}`;
}

/**
 * The host name in what the person typed, as the page's address bar would give it to the extension: a pasted address
 * gives its host ("https://Acme.wd5.myworkdayjobs.com/en-US/x" → "acme.wd5.myworkdayjobs.com"), a bare name loses its
 * path, port and a trailing dot, in lower case, and a name in another script is written as the browser writes it
 * ("bücher.example" → "xn--bcher-kva.example"). What no address can hold ("*", spaces) is left as typed, for the
 * contract's host rule to refuse.
 */
export function hostFromInput(text: string): string {
  const value = text.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value.replace(/^\/\//, '')}`;
  try {
    return new URL(withScheme).hostname.replace(/\.$/, '');
  } catch {
    return value.toLowerCase();
  }
}

/** The host a save names: `*` for every site, else the typed site's host name. */
export function hostOf(form: Pick<SignInForm, 'scope' | 'site'>): string {
  return form.scope === 'any' ? AUTOFILL_ANY_HOST : hostFromInput(form.site);
}

/**
 * The saved sign-in this form would replace (its host is saved already), or null for a new site. A site that is no
 * host name ("*" under One site) replaces nothing: it only gets the host rule's message.
 */
export function existingFor(
  form: Pick<SignInForm, 'scope' | 'site'>,
  items: readonly AutofillSignInItem[],
): AutofillSignInItem | null {
  const host = hostOf(form);
  if (form.scope === 'site' && !HostNameSchema.safeParse(host).success) return null;
  return items.find((item) => item.host === host) ?? null;
}

/** The dialog's start: an edit shows the saved site and email, never a password; an add starts at "All job sites". */
export function formOf(item: AutofillSignInItem | null, items: readonly AutofillSignInItem[]): SignInForm {
  if (item) {
    const any = item.host === AUTOFILL_ANY_HOST;
    return { scope: any ? 'any' : 'site', site: any ? '' : item.host, email: item.email, password: '' };
  }
  // With "All job sites" saved already, a new one is most likely for one site.
  const hasAny = items.some((saved) => saved.host === AUTOFILL_ANY_HOST);
  return { scope: hasAny ? 'site' : 'any', site: '', email: '', password: '' };
}

/** The PUT body: the password only when one was typed (none keeps the saved one). */
export function bodyOf(form: SignInForm): PutAutofillSignInBody {
  const body: PutAutofillSignInBody = { host: hostOf(form), email: form.email.trim() };
  if (form.password !== '') body.password = form.password;
  return body;
}

/** What a save would be refused for, by field. `hasSaved`: the site has a saved password, which an empty one keeps. */
export function validateSignIn(form: SignInForm, hasSaved: boolean): SignInProblems {
  const problems: SignInProblems = {};
  if (form.scope === 'site') {
    // The host rule's own sentence: the body's host is a union with `*`, whose message says less.
    const host = HostNameSchema.safeParse(hostOf(form));
    if (form.site.trim() === '') problems.site = "Enter the site's host name";
    else if (!host.success) problems.site = host.error.issues[0]?.message ?? "Enter the site's host name";
  }
  if (form.email.trim() === '') problems.email = 'Enter the email you sign in with';
  if (form.password === '' && !hasSaved) problems.password = 'Enter the password';
  const parsed = PutAutofillSignInBodySchema.safeParse(bodyOf(form));
  if (!parsed.success) {
    const fields: Record<string, keyof SignInProblems> = { host: 'site', email: 'email', password: 'password' };
    for (const issue of parsed.error.issues) {
      const field = fields[String(issue.path[0])];
      if (field && !problems[field]) problems[field] = issue.message;
    }
  }
  return problems;
}

/** The server's `fields` ("host", "email", "password") as the dialog's fields. */
export function problemsOf(fields: Record<string, string> | undefined): SignInProblems {
  if (!fields) return {};
  const problems: SignInProblems = {};
  if (fields.host) problems.site = fields.host;
  if (fields.email) problems.email = fields.email;
  if (fields.password) problems.password = fields.password;
  return problems;
}
