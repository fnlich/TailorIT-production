-- v3.0 E1: the `refdata` schema's indexes, made after the dumps are loaded (faster than keeping them while loading).
-- The matcher's lookups (features/companies/refdata/match.ts): an item by its registrable domain, CIK or LEI; the items
-- of a name key (a name alone only ever opens a review); an item's subsidiaries; a filer's or an entity's name key.
CREATE INDEX wd_orgs_domain ON wd_orgs(domain) WHERE domain IS NOT NULL;
CREATE INDEX wd_orgs_cik ON wd_orgs(cik) WHERE cik IS NOT NULL;
CREATE INDEX wd_orgs_lei ON wd_orgs(lei) WHERE lei IS NOT NULL;
CREATE INDEX wd_orgs_name_keys ON wd_orgs USING gin(name_keys);
CREATE INDEX wd_orgs_parent ON wd_orgs(parent_qid) WHERE parent_qid IS NOT NULL;
CREATE INDEX sec_filers_name_key ON sec_filers(name_key);
CREATE INDEX gleif_entities_name_key ON gleif_entities(name_key);
CREATE INDEX gleif_relations_parent ON gleif_relations(parent_lei);
