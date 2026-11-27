// v30 E2: what ends a pass on a site (docs/design/part2/13-company-enrichment.md §4 rule 5, 12 §1 test 4): a bot check,
// a CAPTCHA or a login form. The reader never tries to get past one (no other identity, no headless browser, no proxy,
// no faster retry): it answers `blocked` and the host is held. Statuses (401, 403, 429) are judged by the reader; this
// judges a page that answered 200.
//
// A page that only carries a CAPTCHA widget or a sign-in box among its content (a contact form's reCAPTCHA, a header's
// "Sign in" field) is no wall: a page is a wall when its words are few (an interstitial) and it shows the challenge or
// the password field, or when its title says it is a challenge.

/** How much of a page is looked at (a wall is small; its markers are near the top). */
const LOOK_BYTES = 200_000;
/** A page with fewer visible characters than this is an interstitial, not a site's page with a widget on it. */
const WALL_TEXT_MAX = 1_500;

/** Titles of challenge pages (Cloudflare, Akamai, Imperva, DataDome, PerimeterX and their like). */
const CHALLENGE_TITLE =
  /<title[^>]*>\s*(?:just a moment|attention required|access denied|verify(?:ing)? (?:you are|that you are) (?:a )?human|are you a (?:robot|human)|security check|bot (?:check|verification)|please wait while we verify|checking your browser|pardon our interruption|request blocked|captcha)\b/i;
/** Markers of a challenge script or form (in the page's code, not its words). */
const CHALLENGE_MARKERS =
  /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform|cf-chl-|_Incapsula_Resource|captcha-delivery\.com|px-captcha|perimeterx|awswaf|sec-cpt-if|g-recaptcha|recaptcha\/(?:api|enterprise)\.js|h-captcha|hcaptcha\.com\/1\/api\.js|cf-turnstile/i;
const PASSWORD_FIELD = /<input\b[^>]*\btype\s*=\s*["']?password\b/i;

/** The page's visible words, roughly: scripts, styles and tags gone, spaces collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Why a 200 page is a wall TailorIT does not cross (`bot_check`, `captcha`, `login`), or null for a readable page. */
export function wallOf(html: string): 'bot_check' | 'captcha' | 'login' | null {
  const page = html.length > LOOK_BYTES ? html.slice(0, LOOK_BYTES) : html;
  if (CHALLENGE_TITLE.test(page)) return 'bot_check';
  const few = visibleText(page).length < WALL_TEXT_MAX;
  if (few && CHALLENGE_MARKERS.test(page)) return 'captcha';
  if (few && PASSWORD_FIELD.test(page)) return 'login';
  return null;
}

/** Whether an answer's headers say it is a bot check (Cloudflare's managed challenge). */
export function isChallengeAnswer(headers: { get(name: string): string | null }): boolean {
  // v38 ATS-D (SP v38 EVIDENCE.md §23): AWS WAF's challenge or CAPTCHA (`x-amzn-waf-action`, a 202 with no page) too.
  return (headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge' || /^(?:challenge|captcha)$/i.test((headers.get('x-amzn-waf-action') ?? '').trim());
}
