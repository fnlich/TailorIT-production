// v3.0 D2: the data layer's public face. Features import from here (or take `deps.db`); only core/db touches the driver.
// v3.0 PG-0: the PostgreSQL adapter, the database the app opens and the embedded cluster (RET: PostgreSQL only).
export { createPgClient, createPgPool, type PgClientOptions, type PgConnection } from './pg/client';
export { openAppDatabase, type OpenedDatabase } from './engine';
export { jsonPathSteps, postgresDialect, type Dialect } from './dialect';
export {
  NestedTxError,
  TxIoError,
  type DbClient,
  type DbQueries,
  type DbTx,
  type IoGuardMode,
  type Row,
  type RunResult,
  type SqlParam,
  type SqlParams,
  type TxOptions,
} from './types';
