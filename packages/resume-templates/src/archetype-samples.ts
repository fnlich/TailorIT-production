import { normalizeResumeDocument, type ResumeDocument, type RoleArchetype } from '@tailorit/shared';
import { SAMPLE_RESUME } from './sample';

// v33 ROLES (F4): the sample people the template pickers draw for a person's field, one per archetype (shared
// roles/families.ts). The technical one is SAMPLE_RESUME itself, unchanged, so the template tests and thumbnails stay
// as they were. Every person, company and place is made up.

const PROFESSIONAL: ResumeDocument = normalizeResumeDocument({
  templateId: 'one-column-slate',
  markupVersion: 1,
  name: 'Jordan Whitlow',
  title: 'Operations Coordinator',
  totalYearsExperience: 7,
  contact: { phone: '+1 (555) 014-2290', email: 'jordan.w@example.com', location: 'Columbus, OH', linkedin: '', github: '', portfolio: '' },
  header: { hidden: [] },
  summary:
    'Operations coordinator with seven years keeping projects, budgets and vendors on track for growing teams. ' +
    'Turns messy processes into simple checklists and keeps every stakeholder informed.',
  experience: [
    {
      id: 'exp-pro-1',
      hidden: [],
      title: 'Operations Coordinator',
      company: 'Brookfield Home Services',
      period: { from: { y: 2021, m: 3 }, ongoing: true },
      location: 'Columbus, OH',
      description: 'Coordinates scheduling, vendors and reporting for a 120-person service company.',
      achievements: [
        'Cut vendor invoice errors by <b>40%</b> with a shared purchase order log',
        'Built weekly reports that the leadership team uses to plan staffing',
        'Ran the move to a new scheduling system for 60 field staff',
      ],
      skills: ['Microsoft Excel', 'Vendor management'],
    },
    {
      id: 'exp-pro-2',
      hidden: [],
      title: 'Administrative Specialist',
      company: 'Lakeside Insurance Group',
      period: { from: { y: 2018, m: 6 }, to: { y: 2021, m: 2 } },
      location: 'Columbus, OH',
      description: 'Supported a regional office of 25 agents.',
      achievements: ['Organized 3,000 client files during the move to digital records', 'Planned two regional conferences for 150 guests'],
      skills: ['Records management'],
    },
  ],
  education: [
    {
      id: 'edu-pro',
      hidden: ['gpa', 'bullets'],
      degree: 'B.A. Business Administration',
      institution: 'Ohio Valley University',
      period: { from: { y: 2014 }, to: { y: 2018 } },
      location: 'Athens, OH',
    },
  ],
  certifications: [{ id: 'cert-pro', hidden: ['expiry', 'credentialId'], name: 'Certified Associate in Project Management', issuer: 'Project Management Institute', date: '2022' }],
  skills: ['Microsoft Excel', 'Budgeting', 'Vendor management', 'Scheduling', 'Process improvement', 'Reporting', 'Google Workspace', 'Event planning'],
  softSkills: ['Organization', 'Clear communication', 'Problem solving', 'Attention to detail'],
  languages: [{ id: 'lang-pro', language: 'English', proficiency: 'Native', level: 5 }],
});

const HANDS_ON: ResumeDocument = normalizeResumeDocument({
  templateId: 'ats-plain',
  markupVersion: 1,
  name: 'Marcus Okonkwo',
  title: 'Warehouse Lead',
  totalYearsExperience: 8,
  contact: { phone: '+1 (555) 015-6612', email: 'marcus.okonkwo@example.com', location: 'Memphis, TN', linkedin: '', github: '', portfolio: '' },
  header: { hidden: [] },
  summary:
    'Warehouse lead with eight years in fast distribution centers. Keeps a shift safe and on pace, trains new ' +
    'associates and knows every piece of equipment on the floor.',
  experience: [
    {
      id: 'exp-hands-1',
      hidden: [],
      title: 'Warehouse Lead',
      company: 'Riverbend Distribution',
      period: { from: { y: 2021, m: 1 }, ongoing: true },
      location: 'Memphis, TN',
      description: 'Leads a second shift of 18 associates in a 400,000 square foot center.',
      achievements: [
        'Raised picks per hour by <b>22%</b> by rebalancing pick zones',
        'Trained 40 new associates on forklifts and RF scanners',
        'Kept the shift at zero lost-time injuries for two years',
      ],
      skills: ['Forklift operation', 'Inventory counts'],
    },
    {
      id: 'exp-hands-2',
      hidden: [],
      title: 'Forklift Operator',
      company: 'Delta Freight Co',
      period: { from: { y: 2017, m: 4 }, to: { y: 2020, m: 12 } },
      location: 'Memphis, TN',
      description: 'Loaded and unloaded trailers for a regional freight hub.',
      achievements: ['Loaded about 30 trailers a shift with no damaged freight'],
      skills: ['Pallet jack'],
    },
  ],
  education: [
    {
      id: 'edu-hands',
      hidden: ['gpa', 'bullets'],
      degree: 'High school diploma',
      institution: 'Southside High School',
      period: { from: { y: 2013 }, to: { y: 2017 } },
      location: 'Memphis, TN',
    },
  ],
  certifications: [
    { id: 'cert-hands-1', hidden: ['expiry', 'credentialId'], name: 'Forklift Operator Certification', issuer: 'OSHA', date: '2017' },
    { id: 'cert-hands-2', hidden: ['expiry', 'credentialId'], name: 'OSHA 10', issuer: 'OSHA Training Institute', date: '2019' },
  ],
  skills: ['Forklift operation', 'RF scanners', 'Inventory control', 'Shipping and receiving', 'Order picking', 'Safety training'],
  softSkills: ['Leadership', 'Reliability', 'Teamwork'],
  languages: [{ id: 'lang-hands', language: 'English', proficiency: 'Native', level: 5 }],
});

const CARE: ResumeDocument = normalizeResumeDocument({
  templateId: 'one-column-slate',
  markupVersion: 1,
  name: 'Elena Marquez',
  title: 'Registered Nurse',
  totalYearsExperience: 9,
  contact: { phone: '+1 (555) 016-3381', email: 'elena.m@example.com', location: 'Tucson, AZ', linkedin: '', github: '', portfolio: '' },
  header: { hidden: [] },
  summary:
    'Registered nurse with nine years on medical-surgical and telemetry units. Calm under pressure, careful with ' +
    'medications and known for teaching patients and families what to do at home.',
  experience: [
    {
      id: 'exp-care-1',
      hidden: [],
      title: 'Registered Nurse, Medical-Surgical',
      company: 'Desert Valley Medical Center',
      period: { from: { y: 2019, m: 3 }, ongoing: true },
      location: 'Tucson, AZ',
      description: 'Cares for adult patients on a 32-bed unit.',
      achievements: [
        'Cared for five to six patients a shift with no medication errors',
        'Precepted <b>12</b> new graduate nurses',
        'Led the unit’s falls prevention huddle, cutting falls by a third',
      ],
      skills: ['Medication administration', 'Telemetry'],
    },
    {
      id: 'exp-care-2',
      hidden: [],
      title: 'Licensed Practical Nurse',
      company: 'Sunrise Care Center',
      period: { from: { y: 2015, m: 6 }, to: { y: 2019, m: 2 } },
      location: 'Tucson, AZ',
      description: 'Long-term care for 20 residents.',
      achievements: ['Charted vital signs and care plans for 20 residents a shift'],
      skills: ['Wound care'],
    },
  ],
  education: [
    {
      id: 'edu-care',
      hidden: ['gpa', 'bullets'],
      degree: 'B.S. Nursing',
      institution: 'Southwest State University',
      period: { from: { y: 2011 }, to: { y: 2015 } },
      location: 'Tucson, AZ',
    },
  ],
  certifications: [
    { id: 'cert-care-1', hidden: ['expiry', 'credentialId'], name: 'Registered Nurse (RN) License', issuer: 'Arizona State Board of Nursing', date: '2019' },
    { id: 'cert-care-2', hidden: ['expiry', 'credentialId'], name: 'BLS', issuer: 'American Heart Association', date: '2025' },
    { id: 'cert-care-3', hidden: ['expiry', 'credentialId'], name: 'ACLS', issuer: 'American Heart Association', date: '2025' },
  ],
  skills: ['Patient care', 'Medication administration', 'Telemetry', 'Wound care', 'IV therapy', 'Patient education', 'Epic'],
  softSkills: ['Compassion', 'Calm under pressure', 'Teamwork', 'Clear communication'],
  languages: [
    { id: 'lang-care-1', language: 'English', proficiency: 'Native', level: 5 },
    { id: 'lang-care-2', language: 'Spanish', proficiency: 'Fluent', level: 4 },
  ],
});

/** The sample person of each archetype (technical: SAMPLE_RESUME). */
export const ARCHETYPE_SAMPLES: Readonly<Record<RoleArchetype, ResumeDocument>> = {
  technical: SAMPLE_RESUME,
  professional: PROFESSIONAL,
  'hands-on': HANDS_ON,
  care: CARE,
};

/** The sample person a template picker draws for a field's archetype. */
export function sampleResumeFor(archetype: RoleArchetype): ResumeDocument {
  return ARCHETYPE_SAMPLES[archetype];
}
