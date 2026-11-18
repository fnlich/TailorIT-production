# Deploying TailorIT

How to install, configure, run, back up and update TailorIT. The overview and the commands are in
[README.md](README.md).

## 1. Requirements

- **Node.js 24** (24.11 or later, below 25) and npm 11. `.npmrc` makes npm refuse another major version.
- **Windows 11, macOS or Linux.**
- **On Windows, the Microsoft Visual C++ 2015-2022 Redistributable (x64), version 14.44 or later.** The embedded
  PostgreSQL needs it: with an older one its first start (initdb) crashes. Get it from Microsoft's "Latest supported
  Visual C++ Redistributable downloads" page; `npm run doctor` shows the installed version.
- **PostgreSQL 18.** On one machine TailorIT runs an embedded PostgreSQL 18 from npm (no install). **On a server, use a
  PostgreSQL 18 server of your own** (a managed service or your own install) through `DATABASE_URL`: the embedded
  server is for one machine.
- **Google Chrome or Microsoft Edge** for PDF export and thumbnails (found by itself; else `CHROME_PATH`, or
  `npm run setup:browser`).
- **The `claude` CLI** for the AI features: `npm i -g @anthropic-ai/claude-code`, then `claude auth login` as the
  user TailorIT runs as. No API key is used; one subscription serves every account of the install, within its usage
  windows. Without the CLI the rest of TailorIT works.

## 2. Install

```sh
npm ci
copy .env.example .env      # macOS / Linux: cp .env.example .env
npm run doctor
```

`.env` is the one configuration file of both apps (a UTF-16 file saved by PowerShell is fine). Never commit it.
Every value in `.env.example` is empty: blank, or a line left commented, means the default its comment names.

## 3. Configure

### NODE_ENV: production, and nothing else

`npm start` sets `NODE_ENV=production` when it is unset. **Leave it unset, or set it to `production`; never to anything
else on a server.** Outside production the development sign-in helpers are on: sign-in codes are printed to the API's
console when SMTP is not set, and a fixed sign-in code (`AUTH_DEV_FIXED_CODE`) would let anyone sign in as any address.
In production both are forced off. `npm run dev` runs in development mode: use it only on your own machine.

### Addresses

| Key | Default | What it is |
|---|---|---|
| `APP_ORIGIN` | `http://localhost:3100` | The address people open. The API accepts changes only from pages at this address, and Google sign-in must list it. |
| `WEB_HOST`, `WEB_PORT` | `localhost`, `3100` | Where the web server listens. |
| `API_HOST`, `API_PORT` | `127.0.0.1`, `4100` | Where the API listens. The browser never calls it (the web server passes `/api` on), so keep it on `127.0.0.1`. |
| `API_INTERNAL_URL` | `http://API_HOST:API_PORT` | Where the web server reaches the API, when it runs on another machine. |
| `MCP_PUBLIC_URL`, `MCP_ALLOWED_HOSTS` | `APP_ORIGIN/mcp` | The MCP endpoint AI apps connect to (Claude, ChatGPT, people's own clients), and the extra names it answers to. |

**Put HTTPS in front of TailorIT** (a reverse proxy such as Caddy, nginx or IIS) for anything beyond your own machine,
and set `APP_ORIGIN` to the `https://` address people open. Route `/mcp`, `/.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server`, `/oauth/authorize`, `/oauth/token`, `/oauth/register` and `/oauth/revoke`
straight to the API and everything else to the web server: Claude and ChatGPT connect there (they need the public https
address). A network address or `0.0.0.0` in `WEB_HOST` or `API_HOST`
exposes that server to the network. `npm run build` writes the web's way to the API into the build: run it again after
changing an address.

### Sign-in and accounts

- **SMTP** for six-digit email codes (`SMTP_HOST`, `SMTP_PORT` 465 for implicit TLS, `SMTP_SECURE`, `SMTP_USER`,
  `SMTP_PASS`, `SMTP_FROM`), and/or **Google** (`GOOGLE_CLIENT_ID`, a Google Identity Services client id; add
  `APP_ORIGIN` to its Authorized JavaScript origins). In production, with neither, nobody can sign in.
- `ADMIN_EMAILS`: the addresses that become administrators (at sign-in and at every start). On a new install they start
  on the Paid plan for one term.
- `CONTACT_EMAIL`: the "Contact admin" address on the sign-in page, and the one Subscribe and Buy extra credit show.

### Data

`DATA_DIR` holds the embedded database (`pg`, and its password in `pg.password`), uploaded files (`files`), keys
(`keys`: the key of the saved job-site sign-ins) and scratch folders. Default: `%LOCALAPPDATA%\TailorIT` on Windows,
`~/.local/share/tailorit` elsewhere. Keep it private and back it up (section 6).

## 4. Build and run

```sh
npm run build               # the API with tsup (apps/api/dist), the web app with next build
npm start                   # PostgreSQL (embedded, unless DATABASE_URL), the API, the ingest worker, the web server
```

`npm start` stops everything it started on Ctrl+C. To run TailorIT as a service, run `npm start` from this folder
under a service manager (the Windows Task Scheduler at start-up, NSSM, systemd, launchd) as the user whose `claude` CLI
is signed in.

### One ingest worker

The ingest worker reads the enabled job sources on their schedule, works purges, discovery and the companies'
enrichment. `npm start` starts it beside the API. **Run exactly one**: a second `npm run ingest:worker` (another
terminal, another machine on the same database) exits at once, naming the one that runs; one that died is taken over
within a minute and a half. `INGEST_ENABLED=false` reads no source on a schedule. Put a contact address in
`INGEST_USER_AGENT`: job boards see it.

## 5. The database

TailorIT keeps everything in PostgreSQL 18. Every start applies the migrations (`apps/api/migrations-pg`) by itself
(`npm run db:migrate` runs them alone); a migration file that changed after it ran stops the start.

- **The embedded server** (`DATABASE_URL` blank): `npm start` starts it first and stops it last. It listens on
  `127.0.0.1` only, on `PG_PORT` (5442), with its data in `PG_DATA_DIR` (`<DATA_DIR>/pg`) and a random password made at
  its first start in **`<PG_DATA_DIR>.password`**. Its log is `<PG_DATA_DIR>/server.log`. It holds **1 GB of shared
  memory** while it runs (`shared_buffers`) and stores large values compressed with lz4. To change a setting, run
  `ALTER SYSTEM SET <name> = <value>;` from any PostgreSQL client (user `tailorit`, the password file above) and restart
  TailorIT: your value wins over TailorIT's (`ALTER SYSTEM RESET <name>;` brings TailorIT's back). On a machine with
  little memory, `ALTER SYSTEM SET shared_buffers = '256MB';`.
- **A server of your own**: `DATABASE_URL=postgres://user:password@host:5432/tailorit` (PostgreSQL 18; the database
  must exist and the user own it). Nothing is started. `PG_POOL_MAX` (10) sizes each process's connection pool.

**`<PG_DATA_DIR>.password` and every backup hold the database password: keep them private**, like `.env`.

### Partitions

Three tables are partitioned: `job_postings_raw` and `ai_task_payloads` one partition a day (kept `JOB_RAW_KEEP_DAYS`,
30, and `AI_TASK_PAYLOAD_KEEP_DAYS`, 3; Admin › Constants, "Retention"), `job_texts` by job id (kept). Every start makes
today's partitions and two days ahead; the daily housekeeping detaches and drops the days past their keep and makes
the days ahead again. `npm run db:partitions` runs it once and prints what it did.

When a start refuses because of the partitions, its message names the table:

| The message says | Do |
|---|---|
| `... has a DEFAULT partition` | One was added by hand. With TailorIT stopped, detach it (`ALTER TABLE <t> DETACH PARTITION <t>_default`), start TailorIT, copy its rows back (`INSERT INTO <t> SELECT * FROM <t>_default`) and drop the detached table. |
| a lock timeout | A long transaction holds the table: find it in `pg_stat_activity`, let it finish or end it (`pg_terminate_backend`), start again. |
| `... overlaps a partition ... not TailorIT's shape` | A partition with other bounds was made by hand: detach it and move its rows as for a DEFAULT partition. |

## 6. Backups

### The embedded server

The embedded PostgreSQL has no `pg_dump`, so TailorIT has two backups of its own, run from this folder (they read
`.env` like the server):

```sh
npm run db:backup -- cold --to <folder> [--stop]          # copy the stopped cluster, its password, files and keys
npm run db:backup -- cold-restore --from <folder> [--replace]
npm run db:backup -- export --to <folder>                 # a consistent logical export while TailorIT runs
npm run db:backup -- check --from <folder>                # re-read an export against its manifest
npm run db:backup -- restore --from <folder> --database <new database>
npm run db:backup -- use --database <database>            # make it the app's database (TailorIT stopped)
```

- **The cold copy** needs TailorIT stopped (`--stop` stops an idle cluster and starts it again after). Put it back on
  the same PostgreSQL major version with `cold-restore`; `--replace` moves what is there aside, never deletes it.
- **The logical export** reads every table in one snapshot and writes a manifest (row counts and checksums); copy
  `files` and `keys` with it (it does, unless `--database-only`). `restore` loads it into a new database, checking
  every file, with the TailorIT version that made it; `use` then swaps it in and keeps the old database. It holds
  TailorIT's own tables; the company open data (`refdata`, built from the dumps) is left out: after a restore, run
  `npm run refdata:build -- --from <folder>` again (until then company enrichment waits for it, as on a new install). The cold
  copy holds everything.

Keep backups outside `DATA_DIR`, on another disk, and treat them as private: they hold every account's data, and a cold
copy holds the database password and the sign-ins' key. Without `keys` the saved job-site sign-ins cannot be read.
Rehearse a restore after each update.

### A server of your own

Use the server's tools (a PostgreSQL 18 client):

```sh
pg_dump --format=custom --no-owner --no-privileges --file=tailorit.dump "$DATABASE_URL"
createdb --template=template0 tailorit_restored
pg_restore --no-owner --no-privileges --exit-on-error --jobs=4 --dbname=tailorit_restored tailorit.dump
```

A managed service's own backups and point-in-time restore replace the nightly copy; keep a weekly `pg_dump` elsewhere
anyway, and copy `DATA_DIR`'s `files` and `keys` with it.

## 7. Switches that wait for the operator

These features are built and **off**. Each stays off until its setting is given; nothing else turns them on.

| Setting (where) | Off while | It waits for |
|---|---|---|
| `BOT_USER_AGENT` (`.env`) | blank, or still holding `<...>` or an example address | A public page about TailorIT's bot (what it reads, how often, how to opt out) and a role mailbox (never a person's address): `TailorIT/1.0 (+https://<public site>/bot; <role mailbox>)`. Every **new** kind of outside read waits for it: reading a job's own careers page (Add job, link imports, the first start's re-read of older jobs), discovery's validation of new board kinds and Common Crawl, the USAJOBS, Himalayas and Jobicy sources, the site reader (company websites, career pages), Wikidata, SEC and GLEIF lookups, logo.dev. Today's job sources keep `INGEST_USER_AGENT`. A malformed value stops the start, naming the key. |
| `USAJOBS_API_KEY` (`.env`) | empty | A USAJOBS developer key (its requests also carry `BOT_USER_AGENT`'s mailbox). |
| `HIMALAYAS_API_KEY` (`.env`) | empty | A Himalayas key. |
| `LOGO_DEV_KEY` (`.env`) | empty | logo.dev's secret key (a paid plan): missing company logos. |
| Read company websites, `SITE_READER_COMPANY_SITES` (Admin › Constants) | false | A legal review of reading companies' homepages (description, facts, logo). |
| Read career pages, `SITE_READER_CAREER_PAGES` (Admin › Constants) | false | A legal review of reading employers' career pages and of discovering career sites. |
| Live Wikidata lookups, `REFDATA_LIVE_LOOKUPS` (Admin › Constants) | false | Accepting that Wikidata's two APIs are read although robots.txt does not cover them for crawlers (also needs `BOT_USER_AGENT`). |
| `DISCOVERY_PROBES_PER_HOST_PER_DAY` (Admin › Constants) | 0 | A decision to probe job boards for company names. |
| `EXT_AUTO_APPROVE_CLOSED`, `EXT_AUTO_APPROVE_NEW_ATS` (Admin › Constants) | false | Trust in the extension's reports and TailorIT's re-reads: until then an administrator approves each one in Admin › Review. (`EXT_AUTO_APPROVE_NEW_PAGE` has no effect since v3.1.) |
| Publish jobs read from a careers page at once, `PAGE_JOBS_AUTO_PUBLISH` (Admin › Constants) | false | Trust in what TailorIT reads from employers' own pages: until then each new job read from a page's own job data (no ATS API) waits in Admin › Review › New jobs for an administrator's approval. Jobs read through an ATS's API are published at once. |

`DISCOVERY_VALIDATE_V2_KINDS_TODAY` is **on**: boards that discovery finds of the four kinds today's sources read
(Greenhouse, Lever, Ashby, Workable) are checked with `INGEST_USER_AGENT`; set it to false to make them wait for
`BOT_USER_AGENT` too.

## 8. Optional parts

- **The free_tailor job lake** (a read-only SQLite file of another tool): `FT_LAKE_DB_PATH` has no default; set it, or
  give a lake source its own path in Admin › Sources.
- **Google Sheet import** (Admin › Import jobs, read once): a Google Cloud service account's JSON key with the Google
  Sheets API on, at `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` (default `service-account-key.json` in this folder, git-ignored).
  Share each sheet with the key's address as a Viewer. Never commit a key.
- **Company open data**: download a month's Wikidata, SEC and GLEIF dumps by hand into a folder, then
  `npm run refdata:build -- --from <folder>`. Keep that folder outside this repository.

## 9. Security checklist

- `NODE_ENV` unset (so `npm start` makes it `production`) or `production`; never `AUTH_DEV_FIXED_CODE`.
- HTTPS in front, `APP_ORIGIN` the `https://` address, the API on `127.0.0.1`.
- `.env`, `DATA_DIR`, `<PG_DATA_DIR>.password`, the service account key and every backup private, outside the
  repository, never committed.
- SMTP or Google configured for sign-in; `ADMIN_EMAILS` only your administrators.
- One ingest worker; the switches of section 7 off until their conditions are met.

## 10. Updating

1. Back up (section 6).
2. Stop TailorIT.
3. Take the new release (each release is one commit of this repository).
4. `npm ci`, then `npm run build`.
5. Start TailorIT: the new migrations run at the start. A migration that builds an index without blocking writes
   (`CREATE INDEX CONCURRENTLY`) can take minutes on a large database; if one fails, the next start builds it again.

## 11. Troubleshooting

- **PostgreSQL does not start**: on Windows, an initdb crash at the first start means the Visual C++ runtime is older
  than 14.44. "Is the port taken?": another program uses `PG_PORT`; stop it or change `PG_PORT`. The server's log is
  `<PG_DATA_DIR>/server.log`.
- **Port already in use** (3100 or 4100): stop the other process, or change `WEB_PORT` / `API_PORT` together with
  `APP_ORIGIN` and `API_INTERNAL_URL`, then `npm run build` again.
- **No PDF export**: install Chrome or Edge, set `CHROME_PATH`, or run `npm run setup:browser`.
- **AI requests fail**: `npm run doctor`; sign the CLI in with `claude auth login` as the user TailorIT runs as; set
  `AI_CLI_BIN` to its full path when `claude` is not on that user's PATH. Admin › AI shows its health.
- **No sign-in code arrives**: check the `SMTP_*` settings (port 465 is implicit TLS).
- **better-sqlite3 fails to load** after a Node version change: `npm ci` again with Node 24 (only the job lake source
  uses it).
