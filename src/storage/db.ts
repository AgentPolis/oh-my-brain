import { PGlite } from "@electric-sql/pglite";

/**
 * Database abstraction for oh-my-brain.
 * Currently backed by PGLite (embedded PostgreSQL).
 * Can be swapped to Supabase/managed PostgreSQL by implementing
 * the same interface with a pg client.
 */
export interface BrainDB {
  /** Run a query that returns rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Run a statement that doesn't return rows (INSERT, UPDATE, DELETE). */
  exec(sql: string, params?: unknown[]): Promise<void>;

  /** Run multiple statements in a transaction. */
  transaction<T>(fn: (db: BrainDB) => Promise<T>): Promise<T>;

  /** Close the database connection. */
  close(): Promise<void>;

  /** Get the engine name for diagnostics. */
  readonly engine: "pglite" | "postgres" | "supabase";
}

export interface BrainDBFactory {
  /** Create or open a database at the given path. */
  create(dataDir: string): Promise<BrainDB>;
}

async function execWithOptionalParams(
  db: Pick<PGlite, "exec" | "query">,
  sql: string,
  params?: unknown[],
): Promise<void> {
  if (params && params.length > 0) {
    await db.query(sql, params);
    return;
  }

  await db.exec(sql);
}

export class PGLiteDB implements BrainDB {
  readonly engine = "pglite" as const;

  constructor(private readonly db: PGlite) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.db.query<T>(sql, params);
    return result.rows;
  }

  async exec(sql: string, params?: unknown[]): Promise<void> {
    await execWithOptionalParams(this.db, sql, params);
  }

  async transaction<T>(fn: (db: BrainDB) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const wrappedTx: BrainDB = {
        engine: "pglite",
        query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
          const result = await tx.query<T>(sql, params);
          return result.rows;
        },
        exec: async (sql: string, params?: unknown[]) => {
          await execWithOptionalParams(tx, sql, params);
        },
        transaction: async <T>(innerFn: (db: BrainDB) => Promise<T>) => innerFn(wrappedTx),
        close: async () => {},
      };

      return fn(wrappedTx);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export const pgliteFactory: BrainDBFactory = {
  async create(dataDir: string): Promise<BrainDB> {
    const db = new PGlite(dataDir);
    return new PGLiteDB(db);
  },
};
