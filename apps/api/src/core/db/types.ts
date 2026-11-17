import type { Dialect } from './dialect';

// v3.0 D2 (docs/design/part2/11-database.md §9.3): the async data layer. Every feature reads and writes through
// `deps.db`, a DbClient, never through a driver or `.prepare(` (a lint rule outside core/db). D2 wrote it over SQLite;
// v3.0 PG-0 put PostgreSQL behind the same interface (core/db/pg/client.ts), and RET retired SQLite.
//
// The rules (docs/DEVELOPMENT.md, "Data"):
// - SQL uses `?` placeholders with an array of values, or `@name` placeholders with an object. A value is a string, a
//   number, a bigint, a boolean, a Date, a Buffer or null.
// - A row comes back as a plain object (`one` answers undefined for none). Integers (int8, numeric) are JS numbers,
//   times ISO-8601 text, flags booleans (core/db/pg/types.ts).
// - Several statements that must land together run in `tx(async (t) => ...)`. Inside it, `t` and `deps.db` both join
//   the transaction (the async context decides), so a helper that takes `deps` may be called from inside a tx.
// - A tx never awaits outside I/O (HTTP, the AI queue, files, timers): it holds a connection and its row locks while
//   it waits. Tests fail such a tx (the guard: core/db/pg/client.ts), and a lint rule names the known clients.
// - A "check, then write" on one person's limits starts with `lockPerson(userId)` inside its tx (the person's
//   `user_counters` row FOR UPDATE), or uses a unique index with ON CONFLICT.
// - Shared spellings through the dialect helpers (`db.dialect`, core/db/dialect.ts).

/** A value bound to a placeholder. */
export type SqlParam = string | number | bigint | boolean | Date | Buffer | Uint8Array | null | undefined;

/** `?` placeholders take an array; `@name` placeholders take an object. */
export type SqlParams = readonly SqlParam[] | Readonly<Record<string, SqlParam>>;

/** A row as the driver answers it. Pass a type argument to name its columns (a cast, as `as` was before). */
export type Row = Record<string, unknown>;

/** What a write changed. Read a new key with `INSERT ... RETURNING id` and `one`, never a driver's last row id. */
export interface RunResult {
  /** Rows the statement inserted, updated or deleted. */
  changes: number;
}

/** The statements every handle runs: the client, and a transaction's `t`. */
export interface DbQueries {
  /** The first row, or undefined. */
  one<T = Row>(sql: string, params?: SqlParams): Promise<T | undefined>;
  /** Every row. */
  all<T = Row>(sql: string, params?: SqlParams): Promise<T[]>;
  /** A write (or any statement whose rows are not read). */
  run(sql: string, params?: SqlParams): Promise<RunResult>;
  /**
   * Takes the person's lock for the rest of the transaction: every "check, then write" on one person's limits (the
   * resume limit, the auto-apply claim, the credit ledger, the AI queue's per-kind cap) starts with it. Refused
   * outside a tx. It locks the person's `user_counters` row FOR UPDATE (the row made on demand): a second "check,
   * then write" of the same person waits; other people's do not.
   */
  lockPerson(userId: string): Promise<void>;
  /** The shared SQL spellings (JSON reads, insert-or-ignore, booleans, times, now). */
  readonly dialect: Dialect;
}

/** A transaction's handle. No `tx` of its own: a nested transaction is refused; use `savepoint`. */
export interface DbTx extends DbQueries {
  /**
   * Runs `fn` in a savepoint of this transaction: when it throws, its writes are undone and the transaction goes on
   * as it was (then the error is thrown on). Never run two savepoints of one transaction at the same time.
   */
  savepoint<T>(fn: (t: DbTx) => Promise<T>): Promise<T>;
}

export interface TxOptions {
  /** Names the transaction in a guard's message and the log. */
  label?: string;
}

export interface DbClient extends DbQueries {
  /**
   * Runs `fn` in one transaction: committed when it resolves, rolled back when it throws (the error is thrown on).
   * The transaction holds one pool connection until it ends; two requests never share a transaction. A tx started
   * inside another is refused (NestedTxError).
   */
  tx<T>(fn: (t: DbTx) => Promise<T>, options?: TxOptions): Promise<T>;
  /**
   * Runs `fn` atomically: in a savepoint of the transaction this async context is in, or in a transaction of its own
   * when there is none. For a helper that callers use both alone and inside their own tx (what `transaction()` did
   * by joining). Its handle is a DbTx either way.
   */
  atomic<T>(fn: (t: DbTx) => Promise<T>, options?: TxOptions): Promise<T>;
  /** True while the current async context runs inside an open transaction. */
  inTx(): boolean;
  /**
   * Refuses outside I/O (`what`: "the AI queue", "the file store") inside a transaction: throws TxIoError in tests,
   * logs a warning in production. The file store and the AI queue call it.
   */
  assertNoTx(what: string): void;
  /** Refuses new statements, lets running ones finish, then closes its connections. */
  close(): Promise<void>;
}

/** `tx` was called inside an open transaction (its async context). */
export class NestedTxError extends Error {
  constructor(label?: string) {
    super(
      `A transaction cannot start inside another${label ? ` (${label})` : ''}: run the statements on the outer ` +
        "transaction's handle, or use t.savepoint().",
    );
    this.name = 'NestedTxError';
  }
}

/** A transaction waited for outside I/O, or outside I/O was asked for inside one. */
export class TxIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxIoError';
  }
}

/** How a client treats outside I/O inside a tx. */
export type IoGuardMode = 'throw' | 'warn' | 'off';
