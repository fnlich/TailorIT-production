import { TECHNICAL_FAMILY_ID, type RoleFamilyId, type RoleFamilyKey } from '@tailorit/shared';
import { HARD_SKILL_CATEGORIES, NEUTRAL_SKILL_CATEGORY, type HardSkillCategory } from '@tailorit/shared/resume';

// The hard-skill library as an index: the shipped list (skills.json, every spelling under one of the
// HARD_SKILL_CATEGORIES headings; an alias is handed in as a record of its own, under its entry's heading) with each user's own skills laid
// over it. Grouped files a resume's skills under the library's heading for each, in the library's heading order; Plain
// keeps the library-known skills only. Nothing here reads files: the service (./service.ts) hands the records in.
// v33 LEGACY: moved unchanged from the retired packages/render (skills/library.ts).

export interface SkillRecord {
  /** The library's spelling. */
  skill: string;
  category: string;
  /** 1 (most specific) to 5; only orders records that share a name. */
  priority?: number | null;
}

export interface SkillIndex {
  get(skill: string): Readonly<SkillRecord> | undefined;
  readonly size: number;
}

/** How skills are matched: trimmed, lower-cased, inner whitespace collapsed. */
export function skillIndexKey(skill: string): string {
  return skill.trim().toLowerCase().replace(/\s+/g, ' ');
}

const CATEGORY_BY_KEY = new Map<string, HardSkillCategory>(
  HARD_SKILL_CATEGORIES.map((category) => [category.toLowerCase(), category]),
);

/** One of the library's headings (HARD_SKILL_CATEGORIES), in its own spelling, or null. */
export function libraryCategory(value: unknown): HardSkillCategory | null {
  return typeof value === 'string' ? (CATEGORY_BY_KEY.get(value.trim().toLowerCase()) ?? null) : null;
}

/**
 * An index over skill records. Records with an unknown heading get one inferred; where two share a name, the more
 * specific (lower priority number) wins, then the first by name.
 */
export function createSkillIndex(records: Iterable<SkillRecord>): SkillIndex {
  const prepared: Array<SkillRecord & { order: number }> = [];
  const seen = new Set<string>();
  let order = 0;
  for (const record of records) {
    const skill = typeof record?.skill === 'string' ? record.skill.trim() : '';
    if (!skill) continue;
    const exact = skill.toLowerCase();
    if (seen.has(exact)) continue;
    seen.add(exact);
    const priority = typeof record.priority === 'number' && Number.isFinite(record.priority) ? record.priority : 5;
    prepared.push({
      skill,
      category: libraryCategory(record.category) ?? inferSkillCategory(skill),
      priority: Math.max(1, Math.min(5, Math.trunc(priority))),
      order: order++,
    });
  }
  prepared.sort(
    (a, b) =>
      (a.priority ?? 5) - (b.priority ?? 5) ||
      a.skill.localeCompare(b.skill, undefined, { sensitivity: 'base' }) ||
      a.order - b.order,
  );
  const index = new Map<string, Readonly<SkillRecord>>();
  for (const { order: _order, ...record } of prepared) {
    const key = skillIndexKey(record.skill);
    if (key && !index.has(key)) index.set(key, Object.freeze(record));
  }
  return { get: (skill) => index.get(skillIndexKey(skill)), size: index.size };
}

/** The library with `extra` laid over it: a name the library already has keeps the library's record. */
export function withExtraSkills(base: SkillIndex, extra: Iterable<SkillRecord>): SkillIndex {
  const own = createSkillIndex(extra);
  if (own.size === 0) return base;
  return {
    get: (skill) => base.get(skill) ?? own.get(skill),
    get size() {
      return base.size + own.size;
    },
  };
}

// ---------------------------------------------------------------------------------------- heading inference

/**
 * Terms per heading, tried in this order; a skill matches a term it equals or contains. The order matters: a more
 * specific heading (AI/ML, Testing, Security...) is tried before a broader one, and Frameworks and Libraries is the
 * answer when nothing matches. Used for a skill a person adds that the library lacks.
 */
const INFERENCE_RULES: ReadonlyArray<readonly [HardSkillCategory, string]> = [
  ['AI/ML & Data Science', 'ai/ml|machine learning|deep learning|mlops|llm|nlp|natural language|computer vision|rag|prompt engineering|fine-tuning|openai|chatgpt|claude|tensorflow|pytorch|keras|scikit|xgboost|lightgbm|spacy|nltk|pandas|numpy|jupyter|langchain|llamaindex|hugging face|transformers|embedding|vector|pinecone|chroma|weaviate|model training|feature engineering'],
  ['Testing and Quality', 'jest|pytest|cypress|playwright|selenium|mocha|chai|junit|testng|vitest|unittest|minitest|testing|test automation|unit test|integration test|e2e|quality|qa|sonarqube|coverage|load test|performance test'],
  ['Security', 'security|secure|auth|oauth|oidc|saml|jwt|encryption|waf|iam|kms|secrets|vulnerability|penetration|sast|dast|rbac|abac|access control|xss|csrf|threat'],
  ['Observability and Monitoring', 'observability|monitoring|logging|metrics|tracing|dashboard|grafana|kibana|prometheus|datadog|new relic|cloudwatch|cloudtrail|splunk|elk|opentelemetry|pagerduty|sentry|x-ray'],
  ['Data Engineering & Streaming', 'kafka|kinesis|pub/sub|rabbitmq|stream|eventbridge|event hubs|sqs|sns|airflow|dbt|etl|data pipeline|data lake|data warehouse|athena|glue|data factory|synapse|snowflake|bigquery|spark|flink|hadoop'],
  ['Databases and Storage', 'postgres|mysql|sql server|sqlite|oracle|mongo|dynamodb|cassandra|couchdb|redis|memcached|firestore|elasticsearch|solr|influxdb|timescale|neo4j|database|nosql|shard|replication|schema|orm|sqlalchemy|prisma|typeorm|sequelize|mongoose|activerecord|storage|s3|aurora|elasticache|presto|query'],
  ['Version Control & Collaboration', 'git|github|gitlab|bitbucket|pull request|code review|version control|jira|confluence'],
  ['DevOps and CI/CD', 'ci/cd|cicd|deployment|pipeline|github actions|gitlab ci|jenkins|circleci|travis|argocd|flux|terraform|cloudformation|pulumi|ansible|puppet|chef|iac|devops|gitops|docker|kubernetes|helm|openshift'],
  ['APIs and Integration', 'api|rest|graphql|grpc|websocket|webhook|openapi|swagger|integration|message queue|service bus|json|xml'],
  ['Mobile Development', 'ios|android|react native|swiftui|flutter|mobile|kotlin multiplatform|xamarin|app store|google play|testflight'],
  ['Frontend & UI/UX Development', 'react|vue|angular|next.js|nuxt|svelte|frontend|front-end|ui|ux|css grid|tailwind|sass|scss|bootstrap|material ui|chakra|figma|responsive|accessibility|storybook'],
  ['Cloud and Infrastructure', 'aws|azure|gcp|google cloud|cloud|ec2|ecs|eks|fargate|rds|cloudfront|lambda|vpc|route 53|load balanc|autoscaling|serverless|netlify|vercel|heroku'],
  ['Operating Systems & Platforms', 'linux|unix|windows|macos|nginx|apache|operating system|file system|network|bash scripting'],
  ['Software Architecture & Design', 'architecture|microservice|distributed|event-driven|domain-driven|ddd|cqrs|saga|solid|design pattern|hexagonal|monorepo|multi-tenant|scalability|caching'],
  ['Engineering Practices & Methodology', 'agile|scrum|kanban|tdd|bdd|pair programming|documentation|requirements|root cause|incident|on-call|sprint|retrospective'],
];

/** Programming languages by exact name (a contains-match would file "Go" under every heading with a "go" in it). */
const LANGUAGE_NAMES = new Set(
  (
    'abap actionscript ada bash c c# c++ clojure cobol css dart elixir erlang f# fortran go golang groovy haskell ' +
    'html java javascript julia kotlin lua matlab objective-c ocaml perl php pl/sql powershell python r ruby rust ' +
    'scala shell solidity sql swift t-sql typescript vb.net zig'
  ).split(' '),
);

/** A short term ("ui", "rds", "e2e") must stand as a word; a longer one may sit inside a name ("postgresql"). */
function termMatcher(term: string): (name: string) => boolean {
  if (term.length > 3) return (name) => name.includes(term);
  const word = new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`);
  return (name) => word.test(name);
}

const TERMS = INFERENCE_RULES.map(([category, terms]) => [category, terms.split('|').map(termMatcher)] as const);

// ------------------------------------------------------------------------- v33 SKILLS: every other field's

/**
 * Each field's own heading: where a person's own skill of that field goes when no rule places it (not "Frameworks and
 * Libraries", which only the technical family and a caller that names no field keep). General gets the neutral heading.
 */
const FIELD_HEADING: Readonly<Record<RoleFamilyKey, HardSkillCategory>> = {
  technical: 'Frameworks and Libraries',
  'data-analytics': 'Analytics & Reporting',
  'qa-testing': 'Manual Testing',
  'it-support': 'IT Support',
  design: 'Design Tools',
  'product-project': 'Project & Product Management',
  sales: 'Sales & CRM',
  marketing: 'Marketing Tools',
  'writing-media': 'Writing & Editing',
  'customer-service': 'Customer Support',
  administrative: 'Administrative Support',
  finance: 'Accounting & Finance',
  'people-hr': 'HR & Recruiting',
  legal: 'Legal Practice',
  'business-operations': 'Operations & Procurement',
  'logistics-transportation': 'Logistics & Inventory',
  healthcare: 'Clinical & Patient Care',
  education: 'Teaching',
  'social-services': 'Social & Community Services',
  'trades-facilities': 'Trades & Equipment',
  manufacturing: 'Manufacturing & Quality',
  'engineering-physical': 'Engineering & CAD',
  'science-research': 'Laboratory & Research',
  'hospitality-retail': 'Food & Hospitality',
  'protective-services': 'Security & Public Safety',
  general: NEUTRAL_SKILL_CATEGORY,
};

/** The fields whose own skills the technical rules above read first (they write technical skills too). */
const TECHNICAL_RULE_FIELDS: ReadonlySet<string> = new Set(['data-analytics', 'qa-testing', 'it-support', 'product-project', 'design']);

/**
 * Terms per field heading (general knowledge), tried for a skill of a field other than technical: the person's field's
 * heading first, then the others in this order. As above, a term of 3 characters or fewer must stand as a word.
 */
const FIELD_RULES: ReadonlyArray<readonly [HardSkillCategory, string]> = [
  ['Licences & Safety', 'osha|first aid|cpr|safety|hazmat|hazardous material|lockout|ppe|fall protection|bloodborne'],
  ['Office & Productivity', 'excel|microsoft word|outlook|powerpoint|google sheets|google docs|microsoft office|office 365|microsoft 365|spreadsheet|acrobat|google workspace|typing'],
  ['Healthcare Administration', 'medical billing|medical coding|icd-10|cpt|ehr|electronic health|epic|cerner|insurance verification|medical records|patient scheduling'],
  ['Clinical & Patient Care', 'patient|clinical|nursing|vital signs|wound|medication|phlebotomy|triage|catheter|care plan|telemetry|ekg|iv therapy'],
  ['Teaching', 'lesson|classroom|curriculum|student|teaching|instruction|iep|tutoring|early childhood|special education'],
  ['Accounting & Finance', 'accounting|bookkeeping|ledger|payable|receivable|reconciliation|gaap|tax|audit|quickbooks|financial|budget|underwriting'],
  ['HR & Recruiting', 'recruiting|recruitment|hiring|onboarding|hris|payroll|benefits|employee relations|talent'],
  ['Sales & CRM', 'sales|crm|salesforce|hubspot|prospecting|lead generation|cold calling|account management|quota'],
  ['Marketing Tools', 'marketing|seo|google ads|social media|campaign|email marketing|content marketing|brand|advertising'],
  ['Customer Support', 'customer|call center|complaint|zendesk|support ticket|live chat'],
  ['Legal Practice', 'legal|litigation|contract|paralegal|westlaw|lexisnexis|discovery|court|deposition'],
  ['Administrative Support', 'calendar|scheduling|filing|data entry|reception|travel arrangements|office administration|minutes|clerical'],
  ['Logistics & Inventory', 'warehouse|inventory|forklift|shipping|receiving|picking|packing|pallet|logistics|supply chain|freight'],
  ['Driving & Transportation', 'driving|cdl|truck|delivery|route|dispatch|fleet|aviation'],
  ['Manufacturing & Quality', 'manufacturing|production|assembly|machining|cnc|quality control|inspection|lean|six sigma|kaizen|machine operation'],
  ['Trades & Equipment', 'electrical|plumbing|hvac|carpentry|welding|construction|maintenance|repair|installation|wiring|power tools|landscaping|janitorial'],
  ['Engineering & CAD', 'cad|autocad|solidworks|revit|fea|cfd|plc|circuit|structural|drafting'],
  ['Laboratory & Research', 'laboratory|lab|pcr|assay|chromatography|microscopy|cell culture|specimen|research|spectroscopy'],
  ['Social & Community Services', 'case management|counseling|social work|community|crisis|outreach|advocacy'],
  ['Security & Public Safety', 'security officer|patrol|surveillance|cctv|loss prevention|law enforcement|emergency|fire|rescue'],
  ['Food & Hospitality', 'food|cooking|kitchen|menu|culinary|baking|bartend|barista|hotel|guest|housekeeping|catering'],
  ['Retail & Personal Services', 'retail|merchandising|cashier|cash handling|point of sale|hair|nail|cosmetology|massage|grooming'],
  ['Design Tools', 'photoshop|illustrator|indesign|design|typography|canva|sketch|branding'],
  ['Writing & Editing', 'writing|editing|proofreading|copy|journalism|ap style|translation'],
  ['Media Production', 'video|photography|audio|premiere|final cut|podcast|broadcast'],
  ['Project & Product Management', 'roadmap|project management|product management|stakeholder|backlog|gantt|project planning'],
  ['Operations & Procurement', 'procurement|purchasing|vendor|operations|sop|erp|sourcing'],
  ['Analytics & Reporting', 'analytics|statistics|reporting|dashboard|regression|forecasting'],
  ['Manual Testing', 'test case|manual testing|uat|exploratory|test plan'],
  ['IT Support', 'help desk|helpdesk|ticketing|troubleshooting|desktop support|active directory|imaging'],
];
const FIELD_TERMS = FIELD_RULES.map(([category, terms]) => [category, terms.split('|').map(termMatcher)] as const);

/** The heading a field's skill falls back to; "Frameworks and Libraries" for the technical family or no field named. */
export function fieldSkillCategory(family?: RoleFamilyId | null): HardSkillCategory {
  return family ? (FIELD_HEADING[family as RoleFamilyKey] ?? NEUTRAL_SKILL_CATEGORY) : 'Frameworks and Libraries';
}

/** The field heading whose terms a skill matches, the field's own heading first; null for none. */
function fieldRuleCategory(name: string, family: RoleFamilyId): HardSkillCategory | null {
  const own = FIELD_HEADING[family as RoleFamilyKey];
  const ordered = [...FIELD_TERMS.filter(([category]) => category === own), ...FIELD_TERMS.filter(([category]) => category !== own)];
  for (const [category, matchers] of ordered) if (matchers.some((matches) => matches(name))) return category;
  return null;
}

/**
 * The library heading a skill the library lacks most likely belongs under. No field (or the technical family): the
 * technical rules, else "Frameworks and Libraries", as before v3.3. Another field: its terms (and, for the fields that
 * write technical skills too, the technical rules first), else the field's own heading (general: the neutral one).
 */
export function inferSkillCategory(skill: string, family?: RoleFamilyId | null): HardSkillCategory {
  const name = skillIndexKey(skill);
  const field = family && family !== TECHNICAL_FAMILY_ID ? family : null;
  if (!name) return fieldSkillCategory(field);
  if (!field || TECHNICAL_RULE_FIELDS.has(field)) {
    if (LANGUAGE_NAMES.has(name)) return 'Languages';
    for (const [category, matchers] of TERMS) {
      if (matchers.some((matches) => matches(name))) return category;
    }
  }
  if (field) return fieldRuleCategory(name, field) ?? fieldSkillCategory(field);
  return 'Frameworks and Libraries';
}

// ------------------------------------------------------------------------------------ the fallback heading

/**
 * Terms by heading for the fallback heading: the one a resume's own (author-grouped) skill gets when the
 * author did not place it and the library does not know it. A skill matches a term it equals, starts with (then a
 * space, "-" or "/"), ends with (after a space) or holds between spaces. Tried in this order; else Frameworks and
 * Libraries. This was the retired templates' contract's rule (the old render gate), so its terms are kept as they are.
 */
const FALLBACK_RULES: ReadonlyArray<readonly [HardSkillCategory, string]> = [
  [
    'Databases and Storage',
    'activerecord|cassandra|couchdb|database|databases|data lake|dynamodb|elasticsearch|etl|firestore|influxdb|' +
      'memcached|mongo|mongodb|mongoose|mysql|neo4j|nosql|oracle|orm|postgres|postgresql|prisma|psql|query|rdbms|' +
      'rdbms/sql|redis|replication|schema|sequelize|shard|snowflake|solr|sql server|sqlalchemy|timescaledb|typeorm|' +
      'warehouse',
  ],
  [
    'Cloud and Infrastructure',
    'amazon web services|ansible|api gateway|argocd|autoscaling|auto scaling|aws|azure|chef|cloud|cloudfront|' +
      'cloudwatch|datadog|deployment|docker|ec2|ecs|eks|elk|fargate|flux|gcp|google cloud|grafana|helm|iac|iam|' +
      'infrastructure|istio|jenkins|k8s|kube|kubernetes|lambda|linkerd|linux|load balanc|netlify|network|new relic|' +
      'nginx|openshift|prometheus|puppet|route 53|s3|terraform|unix/linux|vpc|vercel',
  ],
  [
    'Frameworks and Libraries',
    'react|react.js|reactjs|next|next.js|nextjs|node|node.js|nodejs|vue|vue.js|vuejs|express|express.js|expressjs|' +
      'angular|angular.js|angularjs|nest|nestjs|nest.js|nuxt|nuxt.js|nuxtjs|django|flask|fastapi|fastify|laravel|' +
      'rails|spring|spring boot|springboot|tensorflow|pytorch|torch|keras|scikit-learn|sklearn|pandas|numpy|redux|' +
      'react router|tailwind|tailwindcss|mui|material ui|sass|scss|svelte|svelte.js|sveltejs|ember|ember.js|emberjs|' +
      'jquery|jquery.js|jqueryjs|bootstrap|graphql|swr|flutter|react native|reactnative|.net|dotnet|asp.net|aspnet|' +
      'babel|chakra ui|cypress|emotion|gatsby|junit|langchain|llamaindex|playwright|prettier|pytest|selenium|' +
      'styled-components|testng|css modules|asp.net core|codeigniter|django rest framework|echo|gin|grpc|koa|ktor|' +
      'spring framework|spring mvc|spring security|swiftui',
  ],
  [
    'Languages',
    'python|javascript|typescript|java|go|golang|rust|ruby|php|c++|c#|kotlin|swift|scala|sql|html|css|elixir|bash|' +
      'dart|perl|r|r language|matlab|lua|groovy|shell|powershell|objective-c|html5|css3',
  ],
  [
    'APIs and Integration',
    'docker|kubernetes|k8s|kube|aws|gcp|azure|git|nginx|redis|celery|postgres|postgresql|psql|mongo|mongodb|mysql|' +
      'nosql|openapi|restful api|rest api|rest|jwt|oauth|jest|mocha|chai|ci/cd|github actions|gitlab ci|vercel|' +
      'netlify|figma|sketch|unix/linux|linux|rdbms/sql|rdbms|webpack|vite|gatsby|eslint|openai api|llm|terraform|' +
      'ansible|jenkins|kafka|rabbitmq|airflow|dbt|snowflake|dynamodb|api|ci|github|gitlab|jira|tdd',
  ],
];

const FALLBACK_TERMS = FALLBACK_RULES.map(([category, terms]) => [category, terms.split('|')] as const);

function matchesTerm(name: string, term: string): boolean {
  return (
    name === term ||
    name.startsWith(`${term} `) ||
    name.startsWith(`${term}-`) ||
    name.startsWith(`${term}/`) ||
    name.endsWith(` ${term}`) ||
    name.includes(` ${term} `)
  );
}

/**
 * The heading a skill is filed under (the old render gate's): the library's, else the fallback rules'. v33 SKILLS: with
 * a field other than technical, a skill the library lacks takes that field's heading (`inferSkillCategory`), never
 * "Frameworks and Libraries"; with no field named, as before.
 */
export function renderSkillCategory(skill: string, library: SkillIndex, family?: RoleFamilyId | null): string {
  const name = skillIndexKey(skill);
  const field = family && family !== TECHNICAL_FAMILY_ID ? family : null;
  if (!name) return fieldSkillCategory(field);
  const known = library.get(skill);
  if (known) return known.category;
  if (field) return inferSkillCategory(skill, field);
  for (const [category, terms] of FALLBACK_TERMS) {
    if (terms.some((term) => matchesTerm(name, term))) return category;
  }
  return 'Frameworks and Libraries';
}
