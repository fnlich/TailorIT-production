import type { Feature } from '../core/feature';
import type { SourceAdapter, SourceKind } from '../features/ingest/types';

// The dev-only seam of a production install: a development install registers its demo data, seed adapter and
// development commands here; this one registers none.
export const DEV_FEATURES: readonly Feature[] = [];
export const DEV_ADAPTERS: Readonly<Partial<Record<SourceKind, SourceAdapter>>> = {};
export const DEV_COMMANDS: Readonly<Record<string, NonNullable<Feature['commands']>[string]>> = {};
