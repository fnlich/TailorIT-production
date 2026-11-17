import { normalizeCompanyName } from '@tailorit/shared';
import { leiOf } from './wikidata';

// v30 E1: GLEIF's Golden Copy (docs/design/part2/13-company-enrichment.md §3.2), as CSV files in the LEI-CDF format
// (the column names below), and its relationship records (RR-CDF: who consolidates whom). An entity's file is told
// from a relationship file by its header. Kept: active entities (their legal name, other names, the headquarters
// address, never the legal address, and the creation date, an incorporation), and active direct and ultimate parents.

export interface GleifEntity {
  lei: string;
  legalName: string;
  nameKey: string;
  otherNames: string[];
  hqCity: string | null;
  hqRegion: string | null;
  hqCountry: string | null;
  status: string | null;
  createdOn: string | null;
}

export interface GleifRelation {
  childLei: string;
  parentLei: string;
  kind: 'direct' | 'ultimate';
}

/** The columns read (LEI-CDF 3.x CSV). */
export const GLEIF_ENTITY_COLUMNS = {
  lei: 'LEI',
  legalName: 'Entity.LegalName',
  hqCity: 'Entity.HeadquartersAddress.City',
  hqRegion: 'Entity.HeadquartersAddress.Region',
  hqCountry: 'Entity.HeadquartersAddress.Country',
  status: 'Entity.EntityStatus',
  createdOn: 'Entity.EntityCreationDate',
} as const;
/** The other names' columns: Entity.OtherEntityNames.OtherEntityName.1, .2, ... */
const OTHER_NAME = /^Entity\.OtherEntityNames\.OtherEntityName\.\d+$/;

/** The columns read (RR-CDF 2.x CSV). */
export const GLEIF_RELATION_COLUMNS = {
  child: 'Relationship.StartNode.NodeID',
  parent: 'Relationship.EndNode.NodeID',
  type: 'Relationship.RelationshipType',
  status: 'Relationship.RelationshipStatus',
} as const;

/** Which GLEIF file a CSV record comes from (by its columns); null for neither. */
export function gleifKindOf(record: Record<string, string>): 'entities' | 'relations' | null {
  if (Object.hasOwn(record, GLEIF_ENTITY_COLUMNS.lei) && Object.hasOwn(record, GLEIF_ENTITY_COLUMNS.legalName)) return 'entities';
  if (Object.hasOwn(record, GLEIF_RELATION_COLUMNS.child) && Object.hasOwn(record, GLEIF_RELATION_COLUMNS.type)) return 'relations';
  return null;
}

const cell = (value: string | undefined, max = 300) => (value && value.trim() ? value.trim().slice(0, max) : null);

/** An active entity of one LEI record; null for an inactive or unreadable one. */
export function entityOf(record: Record<string, string>): GleifEntity | null {
  const lei = leiOf(record[GLEIF_ENTITY_COLUMNS.lei]);
  const legalName = cell(record[GLEIF_ENTITY_COLUMNS.legalName]);
  if (!lei || !legalName) return null;
  const status = cell(record[GLEIF_ENTITY_COLUMNS.status], 20)?.toUpperCase() ?? null;
  if (status !== null && status !== 'ACTIVE') return null;
  const otherNames = Object.keys(record)
    .filter((column) => OTHER_NAME.test(column))
    .map((column) => cell(record[column]))
    .filter((name): name is string => name !== null)
    .slice(0, 10);
  const country = cell(record[GLEIF_ENTITY_COLUMNS.hqCountry], 2)?.toUpperCase() ?? null;
  const region = cell(record[GLEIF_ENTITY_COLUMNS.hqRegion], 10)?.toUpperCase() ?? null;
  const created = cell(record[GLEIF_ENTITY_COLUMNS.createdOn], 40);
  return {
    lei,
    legalName,
    nameKey: normalizeCompanyName(legalName),
    otherNames,
    hqCity: cell(record[GLEIF_ENTITY_COLUMNS.hqCity], 120),
    hqRegion: region && /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(region) ? region : null,
    hqCountry: country && /^[A-Z]{2}$/.test(country) ? country : null,
    status,
    createdOn: created && /^\d{4}-\d{2}-\d{2}/.test(created) ? created.slice(0, 10) : null,
  };
}

/** An active consolidation of one relationship record; null for any other relationship. */
export function relationOf(record: Record<string, string>): GleifRelation | null {
  const childLei = leiOf(record[GLEIF_RELATION_COLUMNS.child]);
  const parentLei = leiOf(record[GLEIF_RELATION_COLUMNS.parent]);
  const type = cell(record[GLEIF_RELATION_COLUMNS.type], 60)?.toUpperCase();
  const status = cell(record[GLEIF_RELATION_COLUMNS.status], 20)?.toUpperCase() ?? 'ACTIVE';
  if (!childLei || !parentLei || childLei === parentLei || status !== 'ACTIVE') return null;
  if (type === 'IS_DIRECTLY_CONSOLIDATED_BY') return { childLei, parentLei, kind: 'direct' };
  if (type === 'IS_ULTIMATELY_CONSOLIDATED_BY') return { childLei, parentLei, kind: 'ultimate' };
  return null;
}
