import {
  ADMIN_EDITABLE_KEYS,
  CONSTANT_KEYS,
  PUBLIC_CONSTANT_KEYS,
  constantOfFormerKey,
  constantSpec,
  envKeysOf,
  formatConstant,
  isConstantKey,
  renderMessage,
  resetText,
  setSharedMessages,
  validateConstant,
  type AdminConstantRow,
  type ConstantKey,
  type ConstantSource,
  type ConstantValue,
  type MessageKey,
  type MessageParams,
  type PublicConstants,
} from '@tailorit/shared';
import type { AppDeps } from '../context';
import { AppError, validationFailed } from '../http/errors';

// v2.0: the constants service (docs/design/v2.0/02-constants.md, "The resolution service"). Every central constant is
// resolved in the order: a valid admin override stored in app_settings (`const:<KEY>`, value {"v": <value>}), else the
// value .env set (config.constants, parsed and checked at startup), else the default in @tailorit/shared's CONSTANTS.
//
// - All `const:*` rows are read into a Map (load(): setupServices awaits it, v3.0 D2); get() reads the Map, never the
//   database, so it stays synchronous.
// - set() and clear() write app_settings (updated_at, updated_by) and the Map in the same call, after the write.
// - start() re-reads the rows every CONSTANTS_RELOAD_MS, so an edit made by hand is picked up without a restart.
// - v3.0 D2: deps built without setupServices (scripts, unit tests) read .env and the defaults until a load() or
//   reload() reads the stored overrides.
// - A stored override that no longer validates (edited by hand, or the spec tightened), or that overrides a constant
//   an admin may not change, is ignored with a warning: the value falls back to .env or the default, and Admin ›
//   Constants shows the row as invalid until it is reset.
// - Readers call get() at the moment of use, never once at load, so a change applies to the next request.
// - A change is logged at info with the key, the source and the admin's id; never a value.
// - v32 FIX-PLAN (E12): a constant renamed keeps its earlier key in its spec's `formerKeys` (TAILOR_PER_HOUR is now
//   FREE_TAILOR_PER_HOUR): an override stored under the earlier key applies while the constant has none of its own
//   (checked by the constant's spec), and a set or a clear of the constant removes the earlier key's row.

/** How often the stored overrides are read again (a technical constant: the design's 60 s). */
export const CONSTANTS_RELOAD_MS = 60_000;
/** The app_settings key prefix of a constant override. */
export const CONSTANT_SETTING_PREFIX = 'const:';

interface Stored {
  /** The raw JSON of the row, to tell a changed row on reload. */
  raw: string;
  /** v32 FIX-PLAN: the earlier key the row is stored under (`formerKeys`), when it is not the constant's own. */
  formerKey?: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** The checked value; absent when the stored override is invalid (ignored). */
  value?: unknown;
}

export interface ConstantsService {
  get<K extends ConstantKey>(key: K): ConstantValue<K>;
  source(key: ConstantKey): ConstantSource;
  /** A message with its placeholders filled; {contact_email} and {reset_time} are filled by the service itself. */
  message(key: MessageKey, params?: MessageParams): string;
  /** Admin › Constants: every constant with its value, source, env key, default, env value and editability. */
  list(): AdminConstantRow[];
  /** One row of list(). */
  row(key: ConstantKey): AdminConstantRow;
  /** Stores an admin override: 400 (validation_failed) when the value does not validate or the key is .env only. */
  set(key: ConstantKey, value: unknown, actorUserId: string | null): Promise<AdminConstantRow>;
  /** Removes the stored override: the value goes back to .env or the default. */
  clear(key: ConstantKey, actorUserId: string | null): Promise<AdminConstantRow>;
  /** GET /api/constants/public's values: the constants whose spec says `public`. */
  publicValues(): PublicConstants;
  /** Bumped by every set and clear, and by every reload that changed something. */
  version(): number;
  /** v3.0 D2: reads the stored overrides the first time (setupServices awaits it), quietly. */
  load(): Promise<void>;
  /** Reads the stored overrides again; true when something changed. */
  reload(): Promise<boolean>;
  /** Reloads every `intervalMs` (CONSTANTS_RELOAD_MS); answers the stop. */
  start(intervalMs?: number): () => void;
}

const settingKey = (key: ConstantKey) => `${CONSTANT_SETTING_PREFIX}${key}`;
/** v32 FIX-PLAN: where `former` stands in the constant's `formerKeys` (the first listed wins). */
const formerRank = (key: ConstantKey, former: string) => constantSpec(key).formerKeys!.indexOf(former);
/** v32 FIX-PLAN: the app_settings keys of a constant's own override and of its earlier keys' (`formerKeys`). */
const settingKeys = (key: ConstantKey) =>
  [key, ...(constantSpec(key).formerKeys ?? [])].map((name) => `${CONSTANT_SETTING_PREFIX}${name}`);

export function createConstantsService(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now'>): ConstantsService {
  let overrides = new Map<ConstantKey, Stored>();
  let version = 1;
  /**
   * v30 CT (edit A, INT-1): a started service (the API's process) shares its public messages with the shared zod checks
   * and validators (setSharedMessages), so an admin's edit reaches them too; a test context never touches them.
   */
  let sharing = false;
  const share = () => {
    if (sharing) setSharedMessages(service.publicValues());
  };
  /** The rows naming no constant, warned about once each. */
  const unknownSeen = new Set<string>();

  async function readRows(): Promise<Map<ConstantKey, Stored>> {
    const rows = await deps.db.all<{ key: string; value: string; updated_at: string | null; updated_by: string | null }>(
      "SELECT key, value, updated_at, updated_by FROM app_settings WHERE key LIKE 'const:%'",
    );
    const found = new Map<ConstantKey, Stored>();
    /** v32 FIX-PLAN: the overrides stored under an earlier key, used where the constant has none of its own. */
    const former = new Map<ConstantKey, Stored>();
    for (const row of rows) {
      const name = row.key.slice(CONSTANT_SETTING_PREFIX.length);
      const key = isConstantKey(name) ? name : constantOfFormerKey(name);
      if (!key) {
        if (!unknownSeen.has(row.key)) deps.log.warn(`[constants] app_settings holds ${row.key}, which names no constant: ignored`);
        unknownSeen.add(row.key);
        continue;
      }
      const stored: Stored = { raw: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by };
      if (key !== name) stored.formerKey = name;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        parsed = undefined;
      }
      const holder = parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, 'v') ? (parsed as { v: unknown }) : null;
      const checked = holder ? validateConstant(key, holder.v) : null;
      if (checked?.ok && constantSpec(key).adminEditable) stored.value = checked.value;
      if (stored.formerKey === undefined) found.set(key, stored);
      else if (!former.has(key) || formerRank(key, name) < formerRank(key, former.get(key)!.formerKey!)) {
        former.set(key, stored);
      }
    }
    for (const [key, stored] of former) if (!found.has(key)) found.set(key, stored);
    return found;
  }

  /** Warns about each stored override that is ignored, once (again only when its row changes). */
  function warnInvalid(rows: Map<ConstantKey, Stored>, previous: Map<ConstantKey, Stored>): void {
    for (const [key, stored] of rows) {
      if (Object.hasOwn(stored, 'value')) continue;
      if (previous.get(key)?.raw === stored.raw) continue;
      const why = constantSpec(key).adminEditable ? 'no longer validates' : 'is for a constant set in .env only';
      const under = stored.formerKey ? ` (stored as ${stored.formerKey})` : '';
      deps.log.warn(`[constants] the stored override of ${key}${under} ${why}: ignored, .env or the default applies`);
    }
  }

  async function load(): Promise<boolean> {
    const next = await readRows();
    const changed =
      next.size !== overrides.size ||
      [...next].some(([key, stored]) => {
        const old = overrides.get(key);
        return !old || old.raw !== stored.raw || old.updatedAt !== stored.updatedAt;
      });
    warnInvalid(next, overrides);
    overrides = next;
    return changed;
  }

  const envOf = (key: ConstantKey) => deps.config.constants[key];
  const hasEnv = (key: ConstantKey) => Object.hasOwn(deps.config.constants, key);

  function source(key: ConstantKey): ConstantSource {
    const stored = overrides.get(key);
    if (stored && Object.hasOwn(stored, 'value')) return 'db';
    return hasEnv(key) ? 'env' : 'default';
  }

  function get<K extends ConstantKey>(key: K): ConstantValue<K> {
    const stored = overrides.get(key);
    if (stored && Object.hasOwn(stored, 'value')) return stored.value as ConstantValue<K>;
    if (hasEnv(key)) return envOf(key) as ConstantValue<K>;
    return constantSpec(key).default as ConstantValue<K>;
  }

  function row(key: ConstantKey): AdminConstantRow {
    const spec = constantSpec(key);
    const value = get(key);
    const stored = overrides.get(key);
    const envSet = hasEnv(key);
    const envKeys = envKeysOf(key);
    return {
      key,
      kind: spec.kind,
      group: spec.group,
      label: spec.label,
      help: spec.help,
      value,
      display: formatConstant(key, value),
      source: source(key),
      defaultValue: spec.default,
      defaultDisplay: formatConstant(key, spec.default as ConstantValue<typeof key>),
      envKey: deps.config.constantsEnvKeys[key] ?? envKeys[0]!,
      envAliases: envKeys.slice(1),
      envSet,
      ...(envSet ? { envValue: envOf(key) } : {}),
      envDisplay: envSet ? formatConstant(key, envOf(key) as ConstantValue<typeof key>) : null,
      adminEditable: spec.adminEditable,
      public: spec.public,
      ...(spec.min !== undefined ? { min: spec.min } : {}),
      ...(spec.max !== undefined ? { max: spec.max } : {}),
      ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}),
      placeholders: [...(spec.placeholders ?? [])],
      ...(spec.choices ? { choices: [...spec.choices] } : {}),
      invalidOverride: stored !== undefined && !Object.hasOwn(stored, 'value'),
      updatedAt: stored?.updatedAt ?? null,
      updatedBy: stored?.updatedBy ?? null,
    };
  }

  function message(key: MessageKey, params: MessageParams = {}): string {
    return renderMessage(get(key), {
      contact_email: get('ADMIN_CONTACT_EMAIL') ?? '',
      reset_time: resetText(get('DAY_RESET_TIME'), get('DAY_RESET_ZONE_LABEL')),
      ...params,
    });
  }

  function refuseUnknown(key: string): asserts key is ConstantKey {
    if (!isConstantKey(key)) throw new AppError('not_found', 'There is no such constant.');
  }

  const service: ConstantsService = {
    get,
    source,
    message,
    row,
    list: () => CONSTANT_KEYS.map(row),

    async set(key, value, actorUserId) {
      refuseUnknown(key);
      if (!ADMIN_EDITABLE_KEYS.includes(key)) {
        throw validationFailed('This constant is set in .env only.', { value: 'This constant is set in .env only.' });
      }
      const checked = validateConstant(key, value);
      if (!checked.ok) throw validationFailed(checked.error, { value: checked.error });
      const now = deps.now().toISOString();
      const raw = JSON.stringify({ v: checked.value });
      await deps.db.run(
        `INSERT INTO app_settings(key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
        [settingKey(key), raw, now, actorUserId],
      );
      // v32 FIX-PLAN: an earlier key's override is replaced by this one (after the write: never neither of them).
      const formerKeys = settingKeys(key).slice(1);
      if (formerKeys.length > 0) {
        await deps.db.run(`DELETE FROM app_settings WHERE key IN (${deps.db.dialect.list(formerKeys.length)})`, formerKeys);
      }
      overrides.set(key, { raw, updatedAt: now, updatedBy: actorUserId, value: checked.value });
      version += 1;
      share();
      deps.log.info(`[constants] ${key} set (db) by ${actorUserId ? `admin ${actorUserId}` : 'TailorIT'}`);
      return row(key);
    },

    async clear(key, actorUserId) {
      refuseUnknown(key);
      // v32 FIX-PLAN: a reset also removes an earlier key's override, so it never applies again.
      const keys = settingKeys(key);
      await deps.db.run(`DELETE FROM app_settings WHERE key IN (${deps.db.dialect.list(keys.length)})`, keys);
      const had = overrides.delete(key);
      if (had) {
        version += 1;
        share();
      }
      deps.log.info(
        `[constants] ${key} cleared by ${actorUserId ? `admin ${actorUserId}` : 'TailorIT'}: ${source(key) === 'env' ? '.env' : 'the default'} applies`,
      );
      return row(key);
    },

    publicValues() {
      return Object.fromEntries(PUBLIC_CONSTANT_KEYS.map((key) => [key, get(key)])) as PublicConstants;
    },

    version: () => version,

    async load() {
      await load();
    },

    async reload() {
      const changed = await load();
      if (changed) {
        version += 1;
        share();
        deps.log.info('[constants] the stored overrides changed: reloaded');
      }
      return changed;
    },

    start(intervalMs = CONSTANTS_RELOAD_MS) {
      sharing = true;
      share();
      const timer = setInterval(() => {
        service.reload().catch((error: unknown) => {
          deps.log.error('[constants] the stored overrides could not be read again', error);
        });
      }, intervalMs);
      timer.unref?.();
      return () => {
        clearInterval(timer);
        sharing = false;
        setSharedMessages({});
      };
    },
  };
  return service;
}

declare module '../context' {
  interface AppServices {
    /** v2.0: the central constants, resolved DB override > .env > default (core/constants). */
    constants?: ConstantsService;
  }
}

/** The constants service of these deps, made on first use when setupServices has not made it (scripts, unit tests). */
export function constantsOf(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): ConstantsService {
  deps.services.constants ??= createConstantsService(deps);
  return deps.services.constants;
}

/** v3.0 D2: the constants service with its stored overrides read (setupServices; a script that builds its own deps). */
export async function loadConstants(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): Promise<ConstantsService> {
  const service = constantsOf(deps);
  await service.load();
  return service;
}
