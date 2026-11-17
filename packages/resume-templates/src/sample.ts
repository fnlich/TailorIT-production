import { normalizeResumeDocument, type ResumeDocument } from '@tailorit/shared';

// The sample person the template thumbnails and the tests draw: apps/api/static/sample-resume.json as an on-page
// editor document (entry ids, structured dates, marked-up text and a layout), with languages, certifications and a
// project added so every short kind of section has something to show.

export const SAMPLE_RESUME: ResumeDocument = normalizeResumeDocument({
  templateId: 'double-column',
  markupVersion: 1,
  name: 'Maren Kowalczyk-Hart',
  title: 'Senior Software Engineer',
  totalYearsExperience: 10,
  contact: {
    phone: '+1 (555) 014-7731',
    email: 'maren.kh@example.com',
    location: 'Minneapolis, MN',
    linkedin: 'linkedin.com/in/maren-kh-example',
    github: '',
    portfolio: '',
  },
  header: { hidden: [] },
  summary:
    'Senior software engineer with ten years building marketplaces and the payment and search systems behind them. ' +
    'Owns services from the first design review to the on-call rotation, prefers small, well-tested changes to big ' +
    'rewrites, and has helped six engineers grow into senior roles.',
  experience: [
    {
      id: 'exp-larkspur',
      hidden: [],
      title: 'Senior Software Engineer',
      company: 'Larkspur Supply Exchange',
      period: { from: { y: 2021, m: 2 }, ongoing: true },
      location: 'Minneapolis, MN',
      description:
        'Leads the checkout and payouts team for a wholesale marketplace moving $900M a year between 14,000 sellers ' +
        'and buyers.',
      achievements: [
        'Rebuilt seller payouts on an idempotent job queue, ending duplicate transfers and cutting support tickets ' +
          'about payouts by 70%',
        'Brought checkout p95 latency from <b>1.9s to 420ms</b> by moving tax and shipping quotes behind a Redis cache',
        'Introduced feature flags and staged rollouts, so the team ships to production twice a day instead of twice ' +
          'a month',
        'Coached three engineers to senior; one now leads the search team',
      ],
      skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'Redis'],
    },
    {
      id: 'exp-driftwood',
      hidden: [],
      title: 'Software Engineer II',
      company: 'Driftwood Analytics',
      period: { from: { y: 2018, m: 5 }, to: { y: 2021, m: 1 } },
      location: 'Chicago, IL',
      description: 'Built the event pipeline and query service for a retail analytics product used by 400 brands.',
      achievements: [
        'Designed an event ingestion path on Kafka handling 3 billion events a month with replay after outages',
        'Shipped a pre-aggregation layer that took dashboard loads from 12 seconds to under 2',
        'Moved the reporting database from one large server to a partitioned PostgreSQL cluster with no customer ' +
          'downtime',
      ],
      skills: ['Python', 'Kafka', 'PostgreSQL'],
    },
    {
      id: 'exp-cobblestone',
      hidden: [],
      title: 'Software Engineer',
      company: 'Cobblestone Learning',
      period: { from: { y: 2016, m: 7 }, to: { y: 2018, m: 4 } },
      location: 'Madison, WI',
      description: 'Full-stack work on an online course platform, from the React course player to the grading service.',
      achievements: [
        'Rewrote the course player in React, lifting lesson completion rates by 18%',
        'Built the CI pipeline the engineering group still uses, taking a release from an afternoon to 15 minutes',
      ],
      skills: ['React', 'JavaScript'],
    },
    {
      id: 'exp-thistle',
      hidden: [],
      title: 'Junior Developer',
      company: 'Thistle & Pine Web Studio',
      period: { from: { y: 2015, m: 6 }, to: { y: 2016, m: 6 } },
      location: 'Madison, WI',
      description: 'Built and maintained client websites and internal tools for a small agency.',
      achievements: ['Automated deployments for 25 client sites, ending a recurring source of broken releases'],
      skills: [],
    },
  ],
  education: [
    {
      id: 'edu-lakeland',
      hidden: ['gpa', 'bullets'],
      degree: 'B.S. Computer Science',
      institution: 'University of Lakeland',
      period: { from: { y: 2011 }, to: { y: 2015 } },
      location: 'Madison, WI',
    },
  ],
  projects: [
    {
      id: 'proj-shelfwise',
      hidden: [],
      name: 'Shelfwise',
      role: 'Creator and maintainer',
      period: { from: { y: 2022, m: 3 }, ongoing: true },
      link: 'example.com/shelfwise',
      description:
        'An open-source tool that keeps stock counts in step across small online shops; ' +
        '<a href="https://example.com/shelfwise/docs">the documentation</a> walks through a first sync.',
      achievements: ['Used by 300 independent shops, with 40 outside contributors'],
    },
  ],
  skills: [
    'TypeScript',
    'JavaScript',
    'Python',
    'Go',
    'SQL',
    'React',
    'Next.js',
    'Node.js',
    'Express',
    'GraphQL',
    'PostgreSQL',
    'Redis',
    'Elasticsearch',
    'Kafka',
    'DynamoDB',
    'AWS',
    'Docker',
    'Kubernetes',
    'Terraform',
    'GitHub Actions',
    'Prometheus',
    'Grafana',
    'Jest',
    'Playwright',
    'Git',
  ],
  softSkills: [
    'Mentoring',
    'Cross-team communication',
    'Stakeholder management',
    'Ownership',
    'Technical writing',
    'Calm under pressure',
  ],
  languages: [
    { id: 'lang-english', language: 'English', proficiency: 'Native', level: 5 },
    { id: 'lang-polish', language: 'Polish', proficiency: 'Proficient', level: 4 },
    { id: 'lang-spanish', language: 'Spanish', proficiency: 'Intermediate', level: 2 },
  ],
  strengths: [
    {
      id: 'str-design',
      hidden: [],
      title: 'Pragmatic design',
      description: 'Picks the simplest design that will survive the next two years of growth.',
    },
    {
      id: 'str-mentorship',
      hidden: [],
      title: 'Mentorship',
      description: 'Six engineers coached into senior roles over five years.',
    },
    {
      id: 'str-incidents',
      hidden: [],
      title: 'Incident ownership',
      description: 'Runs the review through to the fix that stops the incident coming back.',
    },
    {
      id: 'str-writing',
      hidden: [],
      title: 'Clear writing',
      description: 'Design documents that people read before the meeting.',
    },
  ],
  certifications: [
    {
      id: 'cert-aws',
      hidden: ['expiry', 'credentialId'],
      name: 'AWS Certified Solutions Architect - Associate',
      issuer: 'Amazon Web Services',
      date: '2022',
    },
    {
      id: 'cert-cka',
      hidden: ['expiry', 'credentialId'],
      name: 'Certified Kubernetes Administrator',
      issuer: 'The Linux Foundation',
      date: '2023',
    },
  ],
  layout: [
    { ref: 'summary', column: 'main', enabled: true },
    { ref: 'experience', column: 'main', enabled: true },
    { ref: 'education', column: 'main', enabled: true },
    { ref: 'projects', column: 'main', enabled: true },
    { ref: 'skills', column: 'side', enabled: true },
    { ref: 'languages', column: 'side', enabled: true },
    { ref: 'strengths', column: 'side', enabled: true },
    { ref: 'certifications', column: 'side', enabled: true },
  ],
});
