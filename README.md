# TailorIT

TailorIT is a self-hosted job-search workspace:

- **Jobs**: full-text search over postings read from public job boards, with filters, saved searches and each
  company's profile.
- **Auto-apply**: Prepare & Queue makes each saved job's kit (a resume, a cover letter when one is needed, answers to
  the known questions); the TailorIT Autofill browser extension fills the application forms.
- **Job Tracker**: a board, a list and a chart of your applications, with each application's documents, answers and
  notes.
- **Documents**: resumes (uploaded files kept as they are, and an on-page resume editor with print-ready templates),
  cover letters and cover letter templates, with PDF and Word downloads.
- **Admin**: job sources and their schedule, companies, reviews of the extension's reports, users, AI health and
  usage, constants and announcements.

The AI features run through the `claude` command-line tool signed in with a Claude subscription; no API key is used.
Without it, everything else still works.

Deployment, configuration, the database, backups and security are in **[DEPLOY.md](DEPLOY.md)**.

## Requirements

- Node.js 24 (24.11 or later, below 25) and npm 11.
- Windows 11, macOS or Linux. On Windows, the Microsoft Visual C++ 2015-2022 Redistributable (x64), 14.44 or later.
- PostgreSQL 18: TailorIT starts an embedded server of its own (nothing to install), or uses yours through
  `DATABASE_URL`.
- Google Chrome or Microsoft Edge, for PDF export.
- Optional: the `claude` CLI, signed in (`claude auth login`), for the AI features.

## Quick start (one computer)

```sh
npm ci
copy .env.example .env      # macOS / Linux: cp .env.example .env
```

Edit `.env`: at least `ADMIN_EMAILS` (the addresses that become administrators) and a way to sign in (SMTP for email
codes, or a Google client id). Then:

```sh
npm run doctor              # checks Node, PostgreSQL, the browser, the claude CLI and the sign-in settings
npm run build
npm start                   # PostgreSQL, the API, the ingest worker and the web server
```

Open http://localhost:3100 and sign in. There are no passwords: an account is made the first time someone proves an
address (a six-digit email code, or Google).

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Builds the API (`apps/api/dist`) and the web app (`apps/web/.next`). Run it again after changing an address in `.env`. |
| `npm start` | Starts the embedded PostgreSQL (unless `DATABASE_URL` is set), the API, the ingest worker and the web server, in production mode. |
| `npm run dev` | The same from source, with reloading, in development mode (for working on the code; see DEPLOY.md, "Security"). |
| `npm run doctor` | Checks the machine and `.env`. |
| `npm run db:migrate` | Applies the database migrations (every start does this too). |
| `npm run db:backup -- <command>` | Backups and restores (DEPLOY.md, "Backups"). |
| `npm run db:partitions` | Runs the database's daily partition housekeeping once. |
| `npm run ingest:worker` | The ingest worker alone (`npm start` starts it; run only one). |
| `npm run refdata:build -- --from <folder>` | Loads hand-downloaded company open data (Wikidata, SEC, GLEIF); `refdata:match` and `refdata:coverage` match again and report. |
| `npm run resumes:upgrade` | Upgrades stored resumes to the current resume format. |
| `npm run setup:browser` | Downloads Chrome for PDF export when no installed Chrome or Edge can be used. |
| `npm run typecheck`, `npm run lint` | Checks the code. |

## The browser extension

The TailorIT Autofill extension is distributed separately. Each person connects it from Settings › Autofill.
`AUTOFILL_EXTENSION_IDS` in `.env` names the extensions the page hands a connect code to (unset: the extension's own
id).

## Project layout

```
apps/web/            the web app: Next.js 16, React 19, Tailwind 4
apps/api/            the API: Express 4 and PostgreSQL 18; src/features/<feature>/ (one folder per feature),
                     src/ai/ (the claude CLI and its prompts), migrations-pg/ (the schema), static/ (templates, fonts,
                     skills)
packages/shared/     the contracts and rules both apps use
packages/render/     the resume render engine (PDF, preview, Word)
packages/resume-templates/   the resume templates, drawn the same in the editor and the PDF
scripts/             the launchers: dev, start, doctor, setup:browser, db-backup and the .env loader
```

## Updating

Each release of this repository is one commit. To update: back up (DEPLOY.md, "Backups"), stop TailorIT, take the new
release, run `npm ci` and `npm run build`, and start it again; the database migrations run at the start.
