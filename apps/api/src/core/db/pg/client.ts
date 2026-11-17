import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { postgresDialect } from '../dialect';
import {
  NestedTxError,
  TxIoError,
  type DbClient,
  type DbTx,
  type IoGuardMode,
  type Row,
  type RunResult,
  type SqlParams,
  type TxOptions,
} from '../types';
import { bindValues, SqlCache } from './sql';
import { pgTypes } from './types';

// v3.0 PG-0: the PostgreSQL adapter of DbClient (core/db/types.ts), over a node-postgres pool: the app's only one
// since RET retired v2.0's SQLite adapter. How it behaves:
//
// 1. Statements outside a transaction take any free pool connection (autocommit). Several may run at once: there is
//    no queue, PostgreSQL's own locks order the writers.
// 2. `tx(fn)` takes one pool connection for the whole transaction (BEGIN ... COMMIT). AsyncLocalStorage marks the
//    callback's async context, so a statement from it (through `t` or through `deps.db`) runs on that connection;
//    any other statement takes another connection and does not see the open transaction's writes until COMMIT. A
//    `tx` from inside one is refused (NestedTxError). Statements a callback starts without awaiting, still running
//    after its transaction ended, run outside like any other.
// 3. `atomic` and `t.savepoint` are SAVEPOINTs. On PostgreSQL a failed statement aborts the whole transaction (every
//    later statement fails with 25P02) unless a savepoint undoes it: code that catches a statement's error inside a
//    tx and goes on must run that statement in `t.savepoint`. A COMMIT of an aborted transaction is refused here
//    (PostgreSQL would silently roll it back).
// 4. `lockPerson(userId)` locks the person's `user_counters` row FOR UPDATE until the transaction ends (made on demand
//    for an existing account; a missing account locks nothing). Two "check, then write" transactions of one person
//    run one after the other; other people's do not wait.
// 5. The guard. Every statement here is real I/O, so a transaction naturally spans macrotasks; what it must not do is
//    wait for anything else. The guard counts the transaction's statements in flight: when none is in flight at a
//    macrotask's end and the callback has not finished, it is awaiting outside I/O (a timer, a file, HTTP, the AI
//    queue, or a statement of ANOTHER connection, which can wait on this transaction's own locks forever). 'throw' in
//    tests rolls it back with TxIoError; 'warn' logs it. `assertNoTx` refuses outside I/O asked for inside a tx.
// 6. Values: `?`/`@name` placeholders numbered ($n, sql.ts); int8 and numeric read as numbers, timestamptz as ISO
//    text, date as text, json/jsonb as text (types.ts).

export interface PgClientOptions {
  /** 'throw' in tests, 'warn' (the default) in the server and the CLI. */
  ioGuard?: IoGuardMode;
  /** Where 'warn' writes (the server's log). */
  warn?: (message: string) => void;
  /** A pool made elsewhere (the test harness shares one per test database): close() leaves it open unless `endPool`. */
  pool?: pg.Pool;
  /** close() also ends the given pool (the runtime's: deps.ts hands its pool over). */
  endPool?: boolean;
  /** Or the connection settings of a pool of this client's own. */
  connection?: PgConnection;
}

/** v30 SCH: a pool's size when nothing names one (PG_POOL_MAX's default, config/env.ts). */
export const DEFAULT_PG_POOL_MAX = 10;

export interface PgConnection {
  /** A postgres:// URL, or the parts below. */
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** Pool size (default DEFAULT_PG_POOL_MAX). */
  max?: number;
  /** Milliseconds a statement may run before PostgreSQL cancels it (none by default). */
  statementTimeoutMs?: number;
}

/** Every connection: UTC (types.ts reads timestamptz in it), ISO dates, and a name the server's views show. */
export function poolConfig(connection: PgConnection): pg.PoolConfig {
  const options = ['-c TimeZone=UTC', '-c DateStyle=ISO,YMD', '-c IntervalStyle=postgres'];
  if (connection.statementTimeoutMs) options.push(`-c statement_timeout=${connection.statementTimeoutMs}`);
  return {
    connectionString: connection.connectionString,
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    max: connection.max ?? DEFAULT_PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    application_name: 'tailorit',
    options: options.join(' '),
    types: pgTypes,
  };
}

/** A pool with TailorIT's connection settings; idle-connection errors are logged, never thrown. */
export function createPgPool(connection: PgConnection, onError?: (error: Error) => void): pg.Pool {
  const pool = new pg.Pool(poolConfig(connection));
  pool.on('error', (error) => (onError ?? ((e: Error) => console.warn(`[db] idle connection: ${e.message}`)))(error));
  return pool;
}

interface TxState {
  id: number;
  label: string;
  open: boolean;
  client: pg.PoolClient;
  /** The transaction's statements in flight. */
  inFlight: number;
  /** The callback has settled (the guard stops looking). */
  settled: boolean;
  /** The guard found the transaction waiting on something other than its own statements. */
  waitedOnIo: boolean;
  guardArmed: boolean;
  savepoints: number;
  /** The first statement error of the transaction (it aborted the transaction unless a savepoint undid it). */
  failure: { error: unknown; savepointDepth: number } | null;
  depth: number;
  /** The connection runs one statement at a time: each waits for the one before (pg 9 drops pg's own queue). */
  chain: Promise<unknown>;
  handle: DbTx;
}

type Kind = 'one' | 'all' | 'run';

// Taken when this module loads, so a test's fake timers never stop the guard (or fire it early).
const realSetImmediate = globalThis.setImmediate;

const LOCK_SELECT = 'SELECT 1 FROM user_counters WHERE user_id = ? FOR UPDATE';
const LOCK_MAKE =
  'INSERT INTO user_counters(user_id) SELECT id FROM users WHERE id = ? ON CONFLICT (user_id) DO NOTHING';

export function createPgClient(options: PgClientOptions): DbClient {
  const mode: IoGuardMode = options.ioGuard ?? 'warn';
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const ownsPool = !options.pool || options.endPool === true;
  if (!options.pool && !options.connection) throw new Error('createPgClient needs a pool or connection settings.');
  const pool = options.pool ?? createPgPool(options.connection!, (error) => warn(`[db] idle connection: ${error.message}`));
  const context = new AsyncLocalStorage<TxState>();
  const cache = new SqlCache();
  let nextId = 1;
  let closed = false;
  /** Work in flight (statements outside a tx and whole transactions), so close() can wait for it. */
  let busy = 0;
  let idle: (() => void) | null = null;
  const begin = () => {
    busy += 1;
  };
  const end = () => {
    busy -= 1;
    if (busy === 0 && idle) idle();
  };

  const openHere = (): TxState | null => {
    const state = context.getStore();
    return state?.open ? state : null;
  };

  function shape(kind: Kind, result: pg.QueryResult | pg.QueryResult[]): unknown {
    const last = Array.isArray(result) ? result[result.length - 1]! : result;
    if (kind === 'one') return last.rows[0];
    if (kind === 'all') return last.rows;
    return { changes: last.rowCount ?? 0 } satisfies RunResult;
  }

  function guardMessage(what: string, state: TxState): string {
    return `${what} inside a transaction (${state.label}): it holds a connection and its row locks while it waits. Do it before or after the tx.`;
  }

  /** At this macrotask's end: is the transaction waiting with none of its statements in flight? */
  function armGuard(state: TxState): void {
    if (mode === 'off' || state.guardArmed || !state.open || state.settled) return;
    state.guardArmed = true;
    realSetImmediate(() => {
      state.guardArmed = false;
      if (!state.open || state.settled || state.inFlight > 0 || state.waitedOnIo) return;
      state.waitedOnIo = true;
      if (mode === 'warn') warn(`[db] ${guardMessage('A transaction awaited outside I/O', state)}`);
    });
  }

  function abortedMessage(state: TxState): string {
    const first = state.failure?.error;
    const said = first instanceof Error ? first.message : String(first);
    return (
      `${state.label}: an earlier statement in this transaction failed (${said}), which aborts a PostgreSQL ` +
      'transaction. Run a statement whose failure is caught and handled in t.savepoint().'
    );
  }

  async function onTx(state: TxState, kind: Kind, sql: string, params: SqlParams | undefined): Promise<unknown> {
    if (!state.open) throw new Error(`${state.label} has ended: its handle runs no more statements.`);
    const prepared = cache.get(sql);
    const values = bindValues(prepared, params);
    state.inFlight += 1;
    try {
      return shape(kind, await inOrder(state, () => state.client.query(prepared.text, values)));
    } catch (error) {
      if ((error as { code?: string }).code === '25P02' && state.failure) {
        const wrapped = new Error(abortedMessage(state), { cause: error });
        (wrapped as { code?: string }).code = '25P02';
        throw wrapped;
      }
      if (!state.failure) state.failure = { error, savepointDepth: state.depth };
      throw error;
    } finally {
      state.inFlight -= 1;
      armGuard(state);
    }
  }

  async function outside(kind: Kind, sql: string, params: SqlParams | undefined): Promise<unknown> {
    const state = openHere();
    if (state) return onTx(state, kind, sql, params);
    if (closed) throw new Error('The database is closed.');
    const prepared = cache.get(sql);
    const values = bindValues(prepared, params);
    begin();
    try {
      return shape(kind, await pool.query(prepared.text, values));
    } finally {
      end();
    }
  }

  async function lockOn(state: TxState, userId: string): Promise<void> {
    assertPersonId(userId);
    const held = (await onTx(state, 'all', LOCK_SELECT, [userId])) as unknown[];
    if (held.length) return;
    await onTx(state, 'run', LOCK_MAKE, [userId]);
    await onTx(state, 'all', LOCK_SELECT, [userId]);
  }

  function txHandle(state: TxState): DbTx {
    const handle: DbTx = {
      dialect: postgresDialect,
      one: <T = Row>(sql: string, params?: SqlParams) => onTx(state, 'one', sql, params) as Promise<T | undefined>,
      all: <T = Row>(sql: string, params?: SqlParams) => onTx(state, 'all', sql, params) as Promise<T[]>,
      run: (sql: string, params?: SqlParams) => onTx(state, 'run', sql, params) as Promise<RunResult>,
      lockPerson: (userId: string) => lockOn(state, userId),
      async savepoint<T>(fn: (t: DbTx) => Promise<T>): Promise<T> {
        if (!state.open) throw new Error(`${state.label} has ended: its handle runs no more statements.`);
        const name = `sp_${state.id}_${(state.savepoints += 1)}`;
        await control(state, `SAVEPOINT ${name}`);
        state.depth += 1;
        const depth = state.depth;
        try {
          const result = await fn(handle);
          if (state.failure && state.failure.savepointDepth >= depth) {
            // A statement inside failed and the callback went on: the savepoint is aborted; undo it and say so.
            throw new Error(abortedMessage(state), { cause: state.failure.error });
          }
          await control(state, `RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          if (state.open) {
            await control(state, `ROLLBACK TO SAVEPOINT ${name}`);
            await control(state, `RELEASE SAVEPOINT ${name}`);
            if (state.failure && state.failure.savepointDepth >= depth) state.failure = null;
          }
          throw error;
        } finally {
          state.depth -= 1;
        }
      },
    };
    return handle;
  }

  /** Runs `query` after the transaction's statements already sent (one at a time on its connection). */
  function inOrder<T>(state: TxState, query: () => Promise<T>): Promise<T> {
    const run = state.chain.then(query);
    state.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A transaction-control statement on the tx's connection (counted by the guard like any statement). */
  async function control(state: TxState, sql: string): Promise<pg.QueryResult> {
    state.inFlight += 1;
    try {
      return await inOrder(state, () => state.client.query(sql));
    } finally {
      state.inFlight -= 1;
      armGuard(state);
    }
  }

  async function tx<T>(fn: (t: DbTx) => Promise<T>, txOptions: TxOptions = {}): Promise<T> {
    if (openHere()) throw new NestedTxError(txOptions.label);
    if (closed) throw new Error('The database is closed.');
    begin();
    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      end();
      throw error;
    }
    const id = nextId++;
    const state: TxState = {
      id,
      label: txOptions.label ? `tx ${id} ${txOptions.label}` : `tx ${id}`,
      open: true,
      client,
      inFlight: 0,
      settled: false,
      waitedOnIo: false,
      guardArmed: false,
      savepoints: 0,
      failure: null,
      depth: 0,
      chain: Promise.resolve(),
      handle: undefined as unknown as DbTx,
    };
    state.handle = txHandle(state);
    let broken: unknown = null;
    try {
      try {
        await client.query('BEGIN');
      } catch (error) {
        broken = error;
        throw error;
      }
      armGuard(state);
      try {
        const result = await context.run(state, () => fn(state.handle));
        state.settled = true;
        if (state.waitedOnIo && mode === 'throw') {
          throw new TxIoError(guardMessage('A transaction awaited outside I/O (a timer, a file, HTTP, the AI queue)', state));
        }
        if (state.failure) throw new Error(abortedMessage(state), { cause: state.failure.error });
        const committed = await inOrder(state, () => client.query('COMMIT'));
        if (committed.command === 'ROLLBACK') throw new Error(`${state.label} was rolled back by PostgreSQL at COMMIT.`);
        return result;
      } catch (error) {
        state.settled = true;
        try {
          await inOrder(state, () => client.query('ROLLBACK'));
        } catch (rollbackError) {
          broken = rollbackError;
          warn(`[db] ${state.label} could not roll back: ${String(rollbackError)}`);
        }
        throw error;
      }
    } finally {
      state.open = false;
      // A connection whose state is unknown (BEGIN or ROLLBACK failed) is destroyed, never reused.
      client.release(broken ? (broken instanceof Error ? broken : new Error(String(broken))) : undefined);
      end();
    }
  }

  function assertNoTx(what: string): void {
    const state = openHere();
    if (!state || mode === 'off') return;
    const message = guardMessage(`${what} was asked for`, state);
    if (mode === 'throw') throw new TxIoError(message);
    warn(`[db] ${message}`);
  }

  return {
    dialect: postgresDialect,
    one: <T = Row>(sql: string, params?: SqlParams) => outside('one', sql, params) as Promise<T | undefined>,
    all: <T = Row>(sql: string, params?: SqlParams) => outside('all', sql, params) as Promise<T[]>,
    run: (sql: string, params?: SqlParams) => outside('run', sql, params) as Promise<RunResult>,
    async lockPerson(userId: string) {
      const state = openHere();
      if (!state) throw new Error('lockPerson runs inside a transaction (deps.db.tx), where its lock holds.');
      await lockOn(state, userId);
    },
    tx,
    async atomic<T>(fn: (t: DbTx) => Promise<T>, txOptions?: TxOptions): Promise<T> {
      const state = openHere();
      return state ? state.handle.savepoint(fn) : tx(fn, txOptions);
    },
    inTx: () => openHere() !== null,
    assertNoTx,
    async close() {
      if (closed) return;
      closed = true;
      if (busy > 0) {
        // Let work already running finish (a few seconds at most), as SQLite's close let the current statement end.
        await Promise.race([
          new Promise<void>((resolve) => {
            idle = resolve;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 5000).unref()),
        ]);
      }
      if (ownsPool) await pool.end();
    },
  };
}

function assertPersonId(userId: string): void {
  if (typeof userId !== 'string' || userId === '') throw new Error('lockPerson needs the account id of the person.');
}
