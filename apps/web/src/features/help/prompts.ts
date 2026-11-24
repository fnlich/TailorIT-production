// v34 HELP (PLAN G6, CLAUDE-DOCS "at least three working example prompts"): what to ask your AI, by task. Each example
// names the tools your AI uses for it and the inputs it fills, and help.test.ts checks every one against the server's
// own catalogue (@tailorit/shared/mcp-catalog): the tool exists and each input is one of its inputs (`profile` only on a
// tool that takes it). Your AI picks the tools itself; these say what to expect. DIRKIT's submission kit takes its
// examples from this list.

export const PROMPT_TASKS = [
  { id: 'find', title: 'Find jobs' },
  { id: 'save', title: 'Save and add jobs' },
  { id: 'prepare', title: 'Prepare' },
  { id: 'track', title: 'Track and count' },
  { id: 'documents', title: 'Documents with your own AI' },
  { id: 'settings', title: 'Settings and rules' },
  { id: 'profiles', title: 'Shared profiles' },
] as const;
export type PromptTask = (typeof PROMPT_TASKS)[number]['id'];

export interface ExamplePrompt {
  id: string;
  task: PromptTask;
  /** What you type, word for word. */
  text: string;
  /** What happens, in one or two sentences. */
  result: string;
  /** The tools your AI calls, with the inputs it fills on each (`profile` where the example names a shared profile). */
  tools: Readonly<Record<string, readonly string[]>>;
}

/** Whether an example works on a shared profile (some call names one). */
export const namesProfile = (prompt: ExamplePrompt): boolean => Object.values(prompt.tools).some((inputs) => inputs.includes('profile'));

export const EXAMPLE_PROMPTS: readonly ExamplePrompt[] = [
  // Find jobs
  {
    id: 'find-devops',
    task: 'find',
    text: 'Find devops jobs posted since yesterday that need no security clearance.',
    result:
      'Your AI searches with devops words and their kin, counts first (broken down by application system), then lists the first page and offers more.',
    tools: { search_jobs: ['anyOf', 'postedSince', 'clearance', 'countOnly', 'facets'] },
  },
  {
    id: 'find-nurse',
    task: 'find',
    text: 'How many remote registered nurse jobs in Texas pay at least $70,000 a year?',
    result: 'A count, with how many postings do not state their pay, so you can decide before listing them.',
    tools: { search_jobs: ['anyOf', 'remote', 'location', 'salaryMin', 'countOnly'] },
  },
  {
    id: 'find-details',
    task: 'find',
    text: 'For the first three, show the years of experience asked, the salary and the top keywords.',
    result: "One short line per job. The posting's full text is read only if you ask for it.",
    tools: { job_details: ['jobIds'] },
  },
  {
    id: 'find-ai-search',
    task: 'find',
    text: "Use TailorIT's AI search: entry-level data analyst roles in Chicago that sponsor visas.",
    result: "On a Paid account TailorIT's own AI turns the sentence into filters (it counts toward your AI use). Otherwise your AI searches with search_jobs itself.",
    tools: { ai_search_jobs: ['text'] },
  },
  {
    id: 'find-unsupported',
    task: 'find',
    text: 'Find jobs with a four-day work week.',
    result: 'No filter knows the work schedule, so your AI tells you so and reports the request to TailorIT instead of guessing.',
    tools: { search_jobs: ['anyOf'], report_unsupported: ['request', 'missing', 'triedTools'] },
  },
  // Save and add jobs
  {
    id: 'save-them',
    task: 'save',
    text: 'Save them all to my Job Tracker.',
    result:
      'Every match of the last search is saved, not only the page shown, each with its best-matched resume. A job already tracked keeps its status.',
    tools: { save_jobs: ['setId'] },
  },
  {
    id: 'save-link',
    task: 'save',
    text: 'Add this job and save it: <paste the posting link>',
    result: 'TailorIT reads the posting from its link and says what came of it: added and saved, waiting for a check, or refused with the reason.',
    tools: { add_job: ['url'] },
  },
  {
    id: 'save-unsave',
    task: 'save',
    text: 'Unsave the Acme jobs I saved today.',
    result: 'Your AI lists those Saved entries and sends their count with the archive (Claude asks you first). An application you already sent is never touched.',
    tools: { list_applications: ['company', 'status', 'saved'], unsave_jobs: ['setId', 'confirm'] },
  },
  // Prepare
  {
    id: 'prepare-remote',
    task: 'prepare',
    text: 'Prepare my saved remote jobs with TailorIT.',
    result:
      'Your saved Prepare filters run, plus "remote" because you asked for it. Every job that passes is started; your AI writes each kit, and TailorIT queues each job once its kit is saved.',
    tools: {
      filter_jobs: ['scope', 'extra'],
      prepare_start: ['runId'],
      prepare_queue: [],
      prepare_job_context: ['jobId'],
      prepare_prompt: ['jobId', 'step'],
      prepare_save_analysis: ['jobId', 'analysis', 'missing'],
      prepare_save_resume: ['jobId', 'resume', 'revision'],
      prepare_save_cover_letter: ['jobId', 'paragraphs'],
      prepare_save_answers: ['jobs'],
    },
  },
  {
    id: 'prepare-waiting',
    task: 'prepare',
    text: 'Which jobs are still waiting for you to finish their kit?',
    result: 'The jobs your AI started and has not finished, on every profile you work on, a page at a time.',
    tools: { prepare_queue: ['limit'] },
  },
  {
    id: 'prepare-skip',
    task: 'prepare',
    text: 'While you prepare my jobs, skip the Initech one: I already applied there by email.',
    result: 'Among the jobs waiting for your AI, the Initech one is marked skipped with your reason (you read it on the Auto-apply page); its Prepare ends.',
    tools: { prepare_queue: [], prepare_mark: ['jobId', 'status', 'reason'] },
  },
  // Track and count
  {
    id: 'track-week',
    task: 'track',
    text: 'How many jobs did I apply to this week?',
    result: 'A count of the applications whose Applied step falls this week (Monday to Sunday), archived ones too.',
    tools: { application_stats: ['event', 'period'] },
  },
  {
    id: 'track-interviews',
    task: 'track',
    text: 'Interviews this month, by platform.',
    result: 'The applications that reached Interviewing this month, counted by application system: a small table.',
    tools: { application_stats: ['event', 'period', 'groupBy'] },
  },
  // v34 FIX-COPY (final review dir D11): a made-up employer, as in the other examples (Acme, Initech), never a real one.
  {
    id: 'track-story',
    task: 'track',
    text: 'What happened with my Globex application?',
    result: 'Its status steps in order with their days, and whether it is in the auto-apply queue.',
    tools: { list_applications: ['company'], application_timeline: ['applicationId'] },
  },
  {
    id: 'track-needs-you',
    task: 'track',
    text: 'Which auto-applies need me, and why?',
    result: 'The queue rows that stopped for you (a CAPTCHA, a code, a sign-in), each with its reason.',
    tools: { queue_list: ['state'] },
  },
  {
    id: 'track-remove-failed',
    task: 'track',
    text: 'Remove the failed ones from the auto-apply queue.',
    result: 'Your AI lists the failed rows and sends their count with the removal (Claude asks you first). A job the extension is applying to right now stays.',
    tools: { queue_list: ['state'], queue_remove: ['setId', 'confirm'] },
  },
  // Documents with your own AI
  {
    id: 'docs-letter',
    task: 'documents',
    text: 'Write a cover letter for my Acme application with your own words, and save it in TailorIT.',
    result: "Your AI reads TailorIT's prompt for the letter, writes it on your AI plan, and saves it beside the application. It never uses TailorIT's AI.",
    tools: { list_applications: ['company'], own_ai_context: ['feature', 'applicationId'], own_ai_save: ['feature', 'applicationId', 'output'] },
  },
  {
    id: 'docs-tailor',
    task: 'documents',
    text: 'Tailor a resume for the Acme job I saved, without queueing it.',
    result: 'A tailored resume for that one job, written on your AI plan, checked and stored like any other (it counts toward your resumes).',
    tools: { list_applications: ['company'], own_ai_context: ['feature', 'applicationId'], own_ai_save: ['feature', 'applicationId', 'output'] },
  },
  // Settings and rules
  {
    id: 'settings-rounds',
    task: 'settings',
    text: 'From now on, revise each tailored resume up to four times.',
    result: 'Your revision rounds are set to four (you can also change them in Integrations).',
    tools: { set_prepare_settings: ['reviseRounds'] },
  },
  {
    id: 'settings-custom',
    task: 'settings',
    text: 'Remember for every application: keep my resume to one page.',
    result: "Your AI asks to make it your custom instructions; once you approve it in Integrations, your AI reads it after TailorIT's rules and with every Prepare step.",
    tools: { set_prepare_settings: ['customInstructions'] },
  },
  {
    id: 'settings-own-prompts',
    task: 'settings',
    text: "Prepare with my own prompts instead of TailorIT's.",
    result: "Your AI switches the prompt mode; TailorIT still fits what it saves to the kit's structure. \"Use TailorIT's prompts\" switches back.",
    tools: { set_prepare_settings: ['mode'] },
  },
  {
    id: 'settings-rules',
    task: 'settings',
    text: "Read TailorIT's rules first, then tell me what you can do here.",
    result: "Your AI reads TailorIT's instructions (the workflow and the rules) and your custom instructions.",
    tools: { instructions: [] },
  },
  // Shared profiles
  {
    id: 'profiles-search-save',
    task: 'profiles',
    text: "On Ana's profile, find product manager jobs in Boston from this week and save them there.",
    result: "The search and the save run on Ana's profile (her Job Tracker), each call naming it. Your plan pays for any AI used.",
    tools: { search_jobs: ['anyOf', 'location', 'postedSince', 'profile'], save_jobs: ['setId', 'profile'] },
  },
  {
    id: 'profiles-count',
    task: 'profiles',
    text: 'How many applications does Ben have in Interviewing right now?',
    result: "A count from Ben's Job Tracker, if he shared it with you.",
    tools: { application_stats: ['filters', 'profile'] },
  },
  {
    id: 'profiles-prepare-all',
    task: 'profiles',
    text: 'Prepare all for all profiles.',
    result:
      "Your AI runs the filters and starts Prepare on each profile in turn, yours first, then writes every kit. A job prepared on someone else's profile waits for their OK unless they let it apply without one.",
    tools: { filter_jobs: ['scope', 'profile'], prepare_start: ['runId', 'profile'], prepare_queue: [] },
  },
  // v34 MCPFAN (PLAN G5): several profiles in one call.
  {
    id: 'profiles-save-all',
    task: 'profiles',
    text: 'Save these three jobs on every profile.',
    result: 'One save on yours and on each shared profile that lets you save jobs; the answer says what happened on each.',
    tools: { save_jobs: ['ids', 'profile'] },
  },
  // The review round (spec L9): the minimum pay, as the e2e proves it (not an eligibility switch, a sensitive answer).
  {
    id: 'profiles-filters-all',
    task: 'profiles',
    text: 'Set the minimum pay filter to $90,000 on all my profiles.',
    result: 'Changed on yours and on each shared profile where you may change its Job settings; your AI names any shared profile left out.',
    tools: { set_prepare_filters: ['filters', 'profile'] },
  },
];
