// v33 PROMPTS (F5): the slots, the sentences of tailor_builder0's prompts a role family's rendering words differently.
// Each is a piece of the original text, word for word (`from`); the technical family keeps every one as it is, and
// every other family replaces each with its archetype's template filled from its vocabulary pack (archetypes.ts),
// through adapt() (tailor/render.ts), before TailorIT's own, the MCP and the own-AI adaptations. A slot whose words the
// original no longer holds throws at load, as every adaptation does; prompts-roles.test.ts checks that each slot is
// found exactly once and never overlaps another adaptation.

/** The six tailor_builder0 prompts, by their ids. */
export const TAILOR_PROMPT_IDS = [
  'analyze-job-description',
  'review-job-keywords',
  'tailor-resume',
  'revise-resume-ats',
  'write-cover-letter',
  'generate-cover-letter',
] as const;
export type TailorPromptId = (typeof TAILOR_PROMPT_IDS)[number];

export interface Slot {
  /** `<prompt>/<name>`: the key of its template in archetypes.ts. */
  readonly key: string;
  readonly prompt: TailorPromptId;
  /** The original words this slot replaces (a unique piece of the prompt's text). */
  readonly from: string;
}

const slot = (prompt: TailorPromptId, name: string, from: string): Slot => ({ key: `${prompt}/${name}`, prompt, from });

const ANALYZE = 'analyze-job-description';
const REVIEW = 'review-job-keywords';
const TAILOR = 'tailor-resume';
const REVISE = 'revise-resume-ats';

/** Every slot, in the order its words come in its prompt. */
export const SLOTS: readonly Slot[] = [
  // analyze-job-description (the job's family)
  slot(ANALYZE, 'role', 'You are an ATS keyword analyst and expert technical recruiter.'),
  slot(ANALYZE, 'variant', 'an obvious variant such as "K8s" for "Kubernetes"'),
  slot(
    ANALYZE,
    'tool-kind',
    '- "tool" (type "hard"): programming languages, cloud platforms and services, frameworks, databases, operating systems, and IaC, CI/CD, container, observability, and security tools (e.g. Python, AWS, EKS, Terraform, GitHub Actions, Kubernetes, Prometheus, PostgreSQL).',
  ),
  slot(
    ANALYZE,
    'competency-kind',
    '- "competency" (type "hard"): technical practices and concepts (CI/CD, Infrastructure as Code, GitOps, SLOs, incident response, postmortems, code review, runbooks and architecture docs, high availability, DNS, load balancing, cost optimization, Agile) and domain, industry, and compliance terms (payments, fintech, healthcare, PCI DSS, SOC 2, HIPAA).',
  ),
  slot(ANALYZE, 'activities', '- Technical activities (code review, postmortems, runbooks, root-cause analysis, on-call) are technical keywords, not soft skills.'),
  slot(ANALYZE, 'perk', '(a "stipend for AWS certifications" is a perk, not a requirement)'),
  slot(
    ANALYZE,
    'certifications',
    'certifications or licenses a person holds (e.g., CKA, AWS Certified Solutions Architect, CISSP, PMP). Compliance frameworks the work happens under (PCI DSS, SOC 2, HIPAA, ISO 27001) are not certifications; they stay keywords.',
  ),
  slot(ANALYZE, 'mixed', '"4+ years running K8s in production" gives Kubernetes. "Participate in an on-call rotation (one week in six)" gives on-call.'),
  slot(ANALYZE, 'alternatives', '"Python or Go", "PCI DSS or SOC 2": list each term.'),
  slot(
    ANALYZE,
    'lists',
    '"AWS (EC2, S3, IAM)" gives AWS, EC2, S3, and IAM, all at the parent\'s priority. "RDS / Aurora MySQL" gives "RDS" and "Aurora MySQL". Keep fixed names whole ("CI/CD", "Docker Compose", "Application Load Balancers").',
  ),
  slot(ANALYZE, 'qualifiers', '"strong experience with Terraform" gives Terraform;'),
  slot(
    ANALYZE,
    'stack',
    '- Stack and company descriptions ("Our stack:", "We run on..."): industry-standard technologies there are keywords, but they stay nice_to_have unless they also appear in the responsibilities or requirements.',
  ),
  slot(ANALYZE, 'proprietary', 'From "Atlas, our in-house feature-flag service", keep "feature flags" and drop "Atlas".'),
  slot(ANALYZE, 'colleagues', '("partner with Product Managers and Data Scientists")'),
  slot(
    ANALYZE,
    'two-part',
    'A phrase with a technical part and an interpersonal part ("lead incident response") gives a technical keyword (incident response) and a soft skill (leadership).',
  ),
  slot(ANALYZE, 'capitalize', '("capacity planning" becomes "Capacity planning")'),
  slot(ANALYZE, 'duties', '("automate our release process", "improve system performance")'),
  slot(ANALYZE, 'multiword', 'Keep multi-word names whole ("Infrastructure as Code").'),
  slot(ANALYZE, 'title-priority', 'named in the job title (e.g. Kubernetes in "Kubernetes Platform Engineer")'),
  slot(ANALYZE, 'nice-to-have', 'or found only in the company or stack description.'),
  slot(ANALYZE, 'title', 'usually the first heading ("DevOps Engineer")'),
  slot(ANALYZE, 'must-include', '("5+ years of production AWS experience")'),
  slot(ANALYZE, 'rows', '    ["Terraform", "hard", "tool", "must_have"],\n    ["Postmortems", "hard", "competency", "strong"],'),

  // review-job-keywords (the job's family)
  slot(REVIEW, 'stack', 'including the stack and company description,'),
  slot(REVIEW, 'variant', 'an obvious variant such as "K8s" for "Kubernetes"'),
  slot(REVIEW, 'tool-kind', '- kind "tool": named tools, platforms, languages, services, frameworks, databases, standards, and product categories (e.g. SaaS, ERP, REST APIs)'),
  slot(
    REVIEW,
    'competency-kind',
    '- kind "competency": technical practices and concepts of 1-4 words (Performance tuning, Data modeling, Access management), and domain, industry, and compliance terms (Payments, Healthcare, SOC 2),',
  ),
  slot(REVIEW, 'row', '{ "missing": [["Security architecture", "hard", "competency", "strong"]] }'),
  slot(REVIEW, 'nice-to-have', 'or only in the stack or company description)'),

  // tailor-resume (the person's family)
  slot(TAILOR, 'person', 'still read like a capable engineer typed it on a quiet Sunday.'),
  slot(TAILOR, 'casing', 'Lowercase the common words ("capacity planning", "release management") and keep the capitals of product names and acronyms (JFrog Artifactory, RBAC, SBOM).'),
  slot(TAILOR, 'list-count', '(a list of tool or package names doesn\'t count)'),
  slot(TAILOR, 'weaken', '(don\'t turn "CI/CD pipeline" into "CI pipeline")'),
  slot(TAILOR, 'older-tools', 'use only tools that existed in those years. Older and more junior roles get older, simpler stacks and smaller scope.'),
  slot(TAILOR, 'one-system', '- One CI system and one or two monitoring stacks per role, and no tool renamed in the next role.'),
  slot(TAILOR, 'filler', '("Ran capacity planning reviews.")'),
  slot(TAILOR, 'acronym', '("Infrastructure as Code (IaC)")'),
  slot(TAILOR, 'lead-with', '(the years, the stack, a real system, the size of the team)'),
  slot(
    TAILOR,
    'bullets',
    '- Bullets per role, newest first: 5 to 7, then 4 to 6, then 3 to 4, then 2 to 3. At most 18 in total, and never fewer than a role has achievements with metrics. A bullet you add carries no new metrics and fits that role\'s company and stack.',
  ),
  slot(
    TAILOR,
    'hard-skills',
    'hardSkills: 20 to 25 named tools, technologies, platforms, frameworks, languages, protocols and standards (things you can install, run, configure or code in). Compliance frameworks (HIPAA, SOC 2, PCI DSS) are fine. Never duties, role titles, practices ("GitOps", "SLOs") or domain knowledge ("fintech"), which go in bullets.',
  ),
  slot(TAILOR, 'standard-names', 'Use standard names (Terraform, Amazon EKS, GitHub Actions).'),
  slot(TAILOR, 'one-form', '- One form per skill ("EKS", not also "Amazon EKS"). Capitalize unless the tool\'s own name is lowercase (npm, kubectl).'),
  slot(
    TAILOR,
    'areas',
    '- List it the way an engineer knows their own stack. For each area they work in (cloud, containers, infrastructure as code, CI/CD, monitoring, databases, testing), name the 3 to 5 tools they used there, rather than one tool from many unrelated areas.',
  ),
  slot(TAILOR, 'soft-skills', 'softSkills: 8 to 12, chosen only from'),
  slot(TAILOR, 'picture', 'Picture an engineer typing their own resume. They remember what they ran, they name their systems,'),
  slot(TAILOR, 'verbs', 'For example built, ran, wrote, fixed, moved, cut, shipped, migrated, set up, replaced, deleted, split, added, automated, led, trained.'),
  slot(TAILOR, 'numbers', '(45 min down to 9, 3 clusters, about $18k a month)'),
  slot(TAILOR, 'figures', '(14 services, a team of 6)'),

  // revise-resume-ats (the person's family)
  slot(REVISE, 'bullets', '(the newest role holds up to 7 bullets, the next 6, the next 4, older roles 3, and the newest may take one more if nothing else fits)'),
  slot(REVISE, 'list-count', '(a list of tool or package names doesn\'t count)'),
  slot(REVISE, 'casing', 'Lowercase common words ("release management")'),

  // write-cover-letter and generate-cover-letter (the person's family)
  slot('write-cover-letter', 'story', 'covering what was broken or needed, what I did and what changed.'),
  slot('generate-cover-letter', 'verbs', 'Plain verbs over inflated ones: built, led, fixed, shipped, ran;'),
];

/** The slots of one prompt. */
export function slotsOf(prompt: TailorPromptId): readonly Slot[] {
  return SLOTS.filter((entry) => entry.prompt === prompt);
}
