# Skill library (data)

`skills.json` (version 2, since v3.3) is TailorIT's one skill library: the matching library, the resume editor's skill
picker and tailoring's reference live in this one file. It comes from three places:

- **free_tailor v4.2's list**, used as data with the owner's approval and tidied since: **one main skill per family**
  of spellings, the rest of the family as its aliases, sorted, no duplicates;
- **tailor_builder0's tailoring library** (the owner's own earlier project, copied with the owner's permission of
  2026-11-09): its data is kept verbatim in each entry's `tailor` block (it was `tailor-skills.json` until v3.3);
- **every other field's skills**, written from general knowledge in v3.3 (office, healthcare, trades, logistics, sales,
  teaching and the rest of the 26 role families; no proprietary list copied).

TailorIT loads it in memory and overlays per-user skills (`user_skills`); nothing is written back to it.

## The rule

Two skills that would say the same thing twice on one resume are one skill. Listing `.NET`, `.NET Core`, `ASP.NET` and
`ASP.NET Core` side by side reads as padding, so `.NET` is the main skill and the other three are its aliases. A skill
becomes an alias of a main skill when it is:

- **another spelling or wording** of it: `Argo CD` of `ArgoCD`, `Microservices architecture` of `Microservices`;
- **a version or edition**: `HTTP/2` of `HTTP`, `Ubuntu` of `Linux`, `PL/SQL` of `SQL`;
- **a module, extension or standard companion** of a framework or tool: `Spring Security` of `Spring Boot`, `Redux` and
  `React Router` of `React`, `Docker Compose` of `Docker`, `kubectl` of `Kubernetes`;
- **an item of a list that the main skill sums up**: the design patterns of `Design Patterns`, load, stress and soak
  testing of `Performance Testing`, the "Cloud ..." phrasings of `Cloud Computing`.

Separate skills stay separate, even when they are often listed together: alternatives (`MySQL`, `PostgreSQL`; `Jest`,
`Mocha`), different tools (`Docker`, `Kubernetes`, `Helm`), a cloud's services (`AWS Lambda`, `Amazon S3`), languages
and their frameworks (`Python`, `Django`). An everyday English word never joins a family (`Kind`, `Triggers`,
`Promises`, `Paging`, `Ingress`, `Logs`): a resume that says "any kind of" would otherwise read as Kubernetes. Two
distinct skills an alias group would join are separate entries (v3.3 FIX-1 split six such groups).

## What an alias does

- **Matching:** it is the same keyword as its main skill, so a posting that asks for `ASP.NET Core` is met by a resume
  that says `.NET`, and a posting that names both counts one keyword, not two.
- **The skill picker** (`GET /api/skills`, with the resume's `family`) offers the main skills only, the field's first,
  with each one's aliases for the search: typing "ASP.NET Core" suggests `.NET`. An alias typed in is still a known
  skill and is kept as typed.
- **Grouped skills:** an alias is filed under its main skill's heading.

## Layout (version 2)

```json
{
  "version": 2,
  "tailorGroups": [{ "name": "Languages", "categories": ["Languages"] }],
  "tailorSoft": { "technical": ["Accountability"], "shared": ["Accountability"], "healthcare": ["Bedside Manner"] },
  "hard": [
    {
      "skill": "Bash",
      "priority": 1,
      "category": "Languages",
      "aliases": ["Shell Scripting"],
      "families": ["technical", "data-analytics"],
      "tailor": { "heading": "Languages", "priority": 1, "aliases": ["Shell Scripting"] }
    }
  ],
  "soft": ["Adaptability", "Big Picture Thinking"]
}
```

- **`hard`**: sorted by `category` (the order of `HARD_SKILL_CATEGORIES` in `packages/shared/src/resume/catalogue.ts`:
  17 technical headings and 30 field headings such as Office & Productivity, Clinical & Patient Care, Teaching,
  Accounting, Sales & CRM, Logistics & Inventory, Trades & Equipment; `Other Skills` is the neutral fallback no entry
  uses), then `priority` (1 first), then `skill` (case ignored). `category` is the heading Grouped and the editor file
  the skill under; `priority` runs 1 to 5. `aliases` is optional and alphabetical.
- **`families`**: the role-family ids (`RoleFamilyId`, `packages/shared/src/roles/families.ts`) the skill serves, its
  home family first; absent means every family, and `general` reads every entry. v3.2's entries serve technical,
  data-analytics, qa-testing, it-support, product-project and design (and a few more fields where those use them:
  SQL, Python, Tableau, Jira, Figma, HIPAA ...). A field's skills name their home family first and the other fields
  that use them.
- **`tailor`** (optional): `heading` + `priority` make the entry a tailoring skill for every family it names;
  `aliases` is tailoring's alias group verbatim (absent: the entry's own aliases); `name` when tailoring writes it
  differently (GCP, OAuth, OWASP, iOS); `rank` is tailor_builder0's file order (it breaks ties of heading and
  priority); `under` names the tailoring skill whose alias group holds this entry (a note; a test checks it);
  `families` (v3.3 FIX-1) narrows a technical library skill's tailoring block to some other fields (Change Management
  is a Strategy skill for business operations, people and HR, and product and project). A field's heading never sits
  on an entry that names technical.
- **`tailorGroups`**: the tailoring headings that share a line of a grouped skills list, in order.
- **`tailorSoft`**: the tailoring soft skills per family (`technical`: tailor_builder0's 79; `shared` plus each
  field's own for the others).
- **`soft`**: alphabetical, case ignored. The soft scanner reads a hyphen and a space as one, so "Problem Solving" and
  "Problem-solving" are one entry.

## Spellings

- A spelling of 3 characters or fewer of an entry that does not serve technical ("EHR", "IEP", "CPR") belongs to that
  entry's families only: it is never a global synonym (`library-synonyms.ts` leaves it out; the field's job keywords
  pass it through `skillsForFamily`). Never add a short spelling to a technical entry from another field.
- No case-folded or vendor-stripped spelling belongs to two entries (the test lists the 9 reviewed technical vendor
  pairs it allows).
- A field's everyday bare spelling ("HVAC", "Payroll", "Point of Sale", "Epic") belongs on its skill: tailoring keeps
  only reference skills in the skills lists, so a missing spelling sends the skill to the resume's text instead.
  Ambiguous ones stay out (EMR is Amazon EMR's; Word; Canvas; Assembly is the language).
- Licences (BLS, CPR, CDL, RN, OSHA ...) belong to the certification catalogue (`packages/shared/src/match/catalogue.ts`),
  not to this library.

## Who reads it

- **Matching and resume reading** (`apps/api/src/core/skills-vocabulary.ts`: `getSkillLibrary`, `skillsForFamily`):
  the keywords of a posting and of a resume; a person's own skill that matches nothing is filed under their field's
  default heading.
- **Job keywords without AI** (`apps/api/src/features/job-analysis/deterministic.ts`, `DETERMINISTIC_VERSION` 3): the
  skills of the job's family only (a nurse's posting reads the clinical skills, none of the technology).
- **The skill index** (`apps/api/src/core/skills/`: `library.ts`, `skillGroupsFor`, `dedupeSkills`, `skillsFor`,
  `skillsStamp`): grouping and deduping a resume's skills.
- **Tailoring** (`apps/api/src/features/tailor/skills/reference.ts`, `referenceFor(family)`): the heads that serve the
  family, by `tailorGroups` heading order, priority, rank and file order; the groups trimmed to the headings used; the
  soft skills technical's own list, or `shared` plus the field's own (general: shared plus technical's). It decides
  whether a job keyword goes into the hard skills, the soft skills or the resume's text, and how the tailored skills
  are grouped. The technical family's reference is exactly v3.2's `tailor-skills.json` (a deep-equality test against
  `apps/api/test/fixtures/v32-tailor-skills.json`).

## Editing it

1. Add a skill in its place (heading, priority, name, `families`), or as an alias of the main skill of its family.
2. Run `npm run skills:synonyms`: it writes the families into `packages/shared/src/match/library-synonyms.ts`, which is
   what makes an alias the same keyword as its main skill (the shared package imports no JSON).
3. Bump `RESUME_SKILLS_STAMP` (`packages/shared/src/resume/analysis.ts`) and add the new fingerprint to
   `SKILLS_FINGERPRINTS` in `apps/api/test/core.test.ts`: every resume is then read again.
4. If a posting's keywords read without AI would change, bump `DETERMINISTIC_VERSION`.
5. Update the counts in `apps/api/test/skills-library.test.ts`.

Never change a technical entry's `tailor` block: the deep-equality test fails (and the pinned tailoring prompts with
it).

## Tests

- `apps/api/test/skills-library.test.ts`: the layout, the order, that no skill is listed twice, that every alias is
  found in postings and filed under its main skill's heading, and that step 2 was run. It says what to fix.
- `apps/api/test/skills-v2.test.ts`: technical = v3.2's tailoring file; valid family ids; the tailoring data; no
  spelling collisions; the short spellings.
- `apps/api/test/skills-fields.test.ts`: keywords by family, detection, headings, the picker, a stubbed-AI tailoring
  that keeps a field's skills, the stamp-6 reading and the job details' glance; `packages/shared/src/match/licences.test.ts`:
  the licences.

## Counts (v3.3)

2,354 main skills (975 serve technical; about 1,380 have another home field), 4,146 aliases, 1,323 soft skills,
1,636 tailoring skills (245 technical), 187 `under` notes, 40 tailoring groups, 1,634 synonym groups.
