import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { DbQueries } from '../../../core/db/types';
import { csvRecords, filesIn, inputOf, linesOf, textStreamOf, zipEntries, type InputFile } from './dumps/files';
import { entityOf, gleifKindOf, relationOf, type GleifEntity, type GleifRelation } from './dumps/gleif';
import { filerOf, isFilerFile, type SecFiler } from './dumps/sec';
import { isPlaceCode, itemOf, lineItemId, orgOf, parseEntityLine, referencedOf, type WdItem, type WdOrg } from './dumps/wikidata';
import { REFDATA_NEXT } from './format';

// v30 E1: loading a build's dumps into `refdata_next` (docs/design/part2/13-company-enrichment.md §3.2, §10). The
// folder a build reads (`--from <folder>`):
//   wikidata/  the entity dump (*.json or *.json.gz: one entity a line, as Wikidata's latest-all.json.gz; parts of it
//              split into several files are read in name order)
//   sec/       SEC's submissions: CIK##########.json files, or submissions.zip
//   gleif/     GLEIF's Golden Copy: the LEI records and the relationship records, as *.csv, *.csv.gz or *.zip
// Rows go in batches of LOAD_BATCH, each one statement (jsonb_to_recordset over one JSON array), outside any
// transaction (the files are read between statements, never inside one).
//
// The Wikidata dump is read in passes. The first parses every entity: the organisations (orgOf) go to wd_orgs, the
// countries and first-level subdivisions (P297, P300) to wd_items, and the items the organisations point at are noted.
// Each later pass reads only the lines whose id is wanted (lineItemId, no parse of the rest): the noted items, then the
// places a headquarters lies in (P131), level by level, until a subdivision with an ISO code is reached or
// WIKIDATA_PASSES runs out. A real dump is read WIKIDATA_PASSES times at most (a few CPU hours a month: 13 §9).

/** Rows per insert statement. */
export const LOAD_BATCH = 1000;
/** The most passes over the Wikidata dump (the first, then the items pointed at, then two levels of places). */
export const WIKIDATA_PASSES = 4;

export interface LoadCounts {
  wd_orgs: number;
  wd_items: number;
  wikidata_passes: number;
  sec_filers: number;
  gleif_entities: number;
  gleif_relations: number;
}

export interface LoadHooks {
  /** Called after each batch (the build's heartbeat); a throw stops the load. */
  progress: () => Promise<void>;
  signal?: AbortSignal;
}

/** A batch writer of one table: rows are buffered and written LOAD_BATCH at a time. */
function batcher<T>(db: DbQueries, sql: string, toJson: (row: T) => Record<string, unknown>, hooks: LoadHooks) {
  let rows: Array<Record<string, unknown>> = [];
  let written = 0;
  const flush = async () => {
    if (rows.length === 0) return;
    const json = JSON.stringify(rows);
    rows = [];
    written += (await db.run(sql, [json])).changes;
    await hooks.progress();
  };
  return {
    async add(row: T) {
      rows.push(toJson(row));
      if (rows.length >= LOAD_BATCH) await flush();
    },
    flush,
    get written() {
      return written;
    },
  };
}

const ORG_SQL = `INSERT INTO ${REFDATA_NEXT}.wd_orgs(qid, label, description, official_name, name_keys, website, domain, linkedin_id, cik,
    lei, industry_qids, employees, employees_as_of, inception_year, hq_qid, country_qid, exchanges, parent_qid, owner_qid, type_qids)
  SELECT r.qid, r.label, r.description, r.official_name, r.name_keys, r.website, r.domain, r.linkedin_id, r.cik, r.lei, r.industry_qids,
    r.employees, r.employees_as_of, r.inception_year, r.hq_qid, r.country_qid, r.exchanges, r.parent_qid, r.owner_qid, r.type_qids
  FROM jsonb_to_recordset(CAST(? AS jsonb)) AS r(qid text, label text, description text, official_name text, name_keys text[],
    website text, domain text, linkedin_id text, cik text, lei text, industry_qids text[], employees bigint, employees_as_of date,
    inception_year smallint, hq_qid text, country_qid text, exchanges jsonb, parent_qid text, owner_qid text, type_qids text[])
  ON CONFLICT (qid) DO NOTHING`;

const orgJson = (org: WdOrg) => ({
  qid: org.qid,
  label: org.label,
  description: org.description,
  official_name: org.officialName,
  name_keys: org.nameKeys,
  website: org.website,
  domain: org.domain,
  linkedin_id: org.linkedinId,
  cik: org.cik,
  lei: org.lei,
  industry_qids: org.industryQids,
  employees: org.employees,
  employees_as_of: org.employeesAsOf,
  inception_year: org.inceptionYear !== null && Math.abs(org.inceptionYear) < 32_767 ? org.inceptionYear : null,
  hq_qid: org.hqQid,
  country_qid: org.countryQid,
  exchanges: org.exchanges,
  parent_qid: org.parentQid,
  owner_qid: org.ownerQid,
  type_qids: org.typeQids,
});

const ITEM_SQL = `INSERT INTO ${REFDATA_NEXT}.wd_items(qid, label, parent_qid, country_qid, iso_country, iso_region)
  SELECT r.qid, r.label, r.parent_qid, r.country_qid, r.iso_country, r.iso_region
  FROM jsonb_to_recordset(CAST(? AS jsonb)) AS r(qid text, label text, parent_qid text, country_qid text, iso_country text, iso_region text)
  ON CONFLICT (qid) DO NOTHING`;

const itemJson = (item: WdItem) => ({
  qid: item.qid,
  label: item.label,
  parent_qid: item.parentQid,
  country_qid: item.countryQid,
  iso_country: item.isoCountry,
  iso_region: item.isoRegion,
});

const FILER_SQL = `INSERT INTO ${REFDATA_NEXT}.sec_filers(cik, name, name_key, tickers, exchanges, sic, sic_description, city, region, country,
    entity_type, former_names)
  SELECT r.cik, r.name, r.name_key, r.tickers, r.exchanges, r.sic, r.sic_description, r.city, r.region, r.country, r.entity_type, r.former_names
  FROM jsonb_to_recordset(CAST(? AS jsonb)) AS r(cik text, name text, name_key text, tickers text[], exchanges text[], sic text,
    sic_description text, city text, region text, country text, entity_type text, former_names text[])
  ON CONFLICT (cik) DO NOTHING`;

const filerJson = (filer: SecFiler) => ({
  cik: filer.cik,
  name: filer.name,
  name_key: filer.nameKey,
  tickers: filer.tickers,
  exchanges: filer.exchanges,
  sic: filer.sic,
  sic_description: filer.sicDescription,
  city: filer.city,
  region: filer.region,
  country: filer.country,
  entity_type: filer.entityType,
  former_names: filer.formerNames,
});

const ENTITY_SQL = `INSERT INTO ${REFDATA_NEXT}.gleif_entities(lei, legal_name, name_key, other_names, hq_city, hq_region, hq_country, status, created_on)
  SELECT r.lei, r.legal_name, r.name_key, r.other_names, r.hq_city, r.hq_region, r.hq_country, r.status, r.created_on
  FROM jsonb_to_recordset(CAST(? AS jsonb)) AS r(lei text, legal_name text, name_key text, other_names text[], hq_city text,
    hq_region text, hq_country text, status text, created_on date)
  ON CONFLICT (lei) DO NOTHING`;

const entityJson = (entity: GleifEntity) => ({
  lei: entity.lei,
  legal_name: entity.legalName,
  name_key: entity.nameKey,
  other_names: entity.otherNames,
  hq_city: entity.hqCity,
  hq_region: entity.hqRegion,
  hq_country: entity.hqCountry,
  status: entity.status,
  created_on: entity.createdOn,
});

const RELATION_SQL = `INSERT INTO ${REFDATA_NEXT}.gleif_relations(child_lei, parent_lei, kind)
  SELECT r.child_lei, r.parent_lei, r.kind FROM jsonb_to_recordset(CAST(? AS jsonb)) AS r(child_lei text, parent_lei text, kind text)
  ON CONFLICT DO NOTHING`;

const relationJson = (relation: GleifRelation) => ({ child_lei: relation.childLei, parent_lei: relation.parentLei, kind: relation.kind });

function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The refdata build was stopped.');
}

/** The dump files of a build's folder, by source. */
export function dumpFilesOf(from: string): { wikidata: string[]; sec: string[]; gleif: string[] } {
  return {
    wikidata: filesIn(join(from, 'wikidata'), ['.json', '.json.gz']),
    sec: filesIn(join(from, 'sec'), ['.json', '.zip']),
    gleif: filesIn(join(from, 'gleif'), ['.csv', '.csv.gz', '.zip']),
  };
}

/** Loads the Wikidata dump's files (see the module's note). */
export async function loadWikidata(db: DbQueries, files: readonly string[], hooks: LoadHooks): Promise<{ orgs: number; items: number; passes: number }> {
  const orgs = batcher(db, ORG_SQL, orgJson, hooks);
  const items = batcher(db, ITEM_SQL, itemJson, hooks);
  const loaded = new Set<string>();
  const wanted = new Set<string>();
  /** Items read as places: a place without an ISO code of its own wants the place it lies in. */
  const places = new Set<string>();

  // Pass 1: every entity.
  for (const file of files) {
    for await (const line of linesOf(textStreamOf(file))) {
      stopIfAborted(hooks.signal);
      const entity = parseEntityLine(line);
      if (!entity) continue;
      const org = orgOf(entity);
      if (org) {
        await orgs.add(org);
        const referenced = referencedOf(org);
        for (const qid of referenced.places) {
          wanted.add(qid);
          places.add(qid);
        }
        for (const qid of referenced.others) wanted.add(qid);
      }
      if (isPlaceCode(entity)) {
        const item = itemOf(entity);
        if (item && !loaded.has(item.qid)) {
          loaded.add(item.qid);
          await items.add(item);
        }
      }
    }
  }
  await orgs.flush();
  await items.flush();

  // Later passes: only the wanted items.
  let passes = 1;
  let next = new Set([...wanted].filter((qid) => !loaded.has(qid)));
  while (next.size > 0 && passes < WIKIDATA_PASSES) {
    passes += 1;
    const chase = new Set<string>();
    for (const file of files) {
      for await (const line of linesOf(textStreamOf(file))) {
        stopIfAborted(hooks.signal);
        const id = lineItemId(line);
        if (!id || !next.has(id) || loaded.has(id)) continue;
        const entity = parseEntityLine(line);
        const item = entity ? itemOf(entity) : null;
        if (!item) continue;
        loaded.add(item.qid);
        await items.add(item);
        // A place with no ISO code of its own: the place it lies in, at the next pass.
        if (places.has(item.qid) && !item.isoRegion && !item.isoCountry) {
          for (const parent of [item.parentQid, item.countryQid]) {
            if (parent && !loaded.has(parent)) {
              chase.add(parent);
              places.add(parent);
            }
          }
        }
      }
    }
    await items.flush();
    next = new Set([...chase].filter((qid) => !loaded.has(qid)));
  }
  return { orgs: orgs.written, items: items.written, passes };
}

/** Loads SEC's submissions (files or a ZIP of them). */
export async function loadSec(db: DbQueries, files: readonly string[], hooks: LoadHooks): Promise<number> {
  const filers = batcher(db, FILER_SQL, filerJson, hooks);
  const take = async (text: string) => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const filer = filerOf(json);
    if (filer) await filers.add(filer);
  };
  for (const file of files) {
    if (file.toLowerCase().endsWith('.zip')) {
      for (const entry of await zipEntries(file)) {
        stopIfAborted(hooks.signal);
        if (isFilerFile(entry.name)) await take(await entry.text());
      }
    } else if (isFilerFile(file)) {
      stopIfAborted(hooks.signal);
      let text = '';
      for await (const chunk of textStreamOf(file)) text += String(chunk);
      await take(text);
    }
  }
  await filers.flush();
  return filers.written;
}

/** Loads GLEIF's CSV files (the LEI records and the relationship records, told apart by their columns). */
export async function loadGleif(db: DbQueries, files: readonly string[], hooks: LoadHooks): Promise<{ entities: number; relations: number }> {
  const entities = batcher(db, ENTITY_SQL, entityJson, hooks);
  const relations = batcher(db, RELATION_SQL, relationJson, hooks);
  const readCsv = async (name: string, stream: Readable) => {
    let kind: 'entities' | 'relations' | null | undefined;
    for await (const record of csvRecords(stream)) {
      stopIfAborted(hooks.signal);
      if (kind === undefined) {
        kind = gleifKindOf(record);
        if (!kind) throw new Error(`${name} is not a GLEIF LEI or relationship file (its columns are neither).`);
      }
      if (kind === 'entities') {
        const entity = entityOf(record);
        if (entity) await entities.add(entity);
      } else {
        const relation = relationOf(record);
        if (relation) await relations.add(relation);
      }
    }
  };
  for (const file of files) {
    if (file.toLowerCase().endsWith('.zip')) {
      for (const entry of await zipEntries(file)) {
        if (entry.name.toLowerCase().endsWith('.csv')) await readCsv(entry.name, entry.stream());
      }
    } else {
      await readCsv(file, textStreamOf(file));
    }
  }
  await entities.flush();
  await relations.flush();
  return { entities: entities.written, relations: relations.written };
}

/** The records of a folder's dump files (names and sizes, never their contents). */
export function inputsOf(files: { wikidata: string[]; sec: string[]; gleif: string[] }): InputFile[] {
  return [
    ...files.wikidata.map((file) => inputOf('wikidata', file)),
    ...files.sec.map((file) => inputOf('sec', file)),
    ...files.gleif.map((file) => inputOf('gleif', file)),
  ];
}
