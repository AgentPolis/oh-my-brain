/**
 * Shared PGLite test helper.
 *
 * Instead of each test file creating its own PGLite instance
 * (200ms startup each), this provides a fast in-memory instance
 * with table truncation between tests.
 */

import { PGlite } from "@electric-sql/pglite";
import { PGLiteDB } from "../../src/storage/db.js";
import { initPgSchema } from "../../src/storage/pg-schema.js";
import type { BrainDB } from "../../src/storage/db.js";

let sharedDb: PGLiteDB | null = null;
let refCount = 0;

/**
 * Get a fast in-memory PGLite instance.
 * First call initializes it (~200ms). Subsequent calls reuse it (~0ms).
 * Call `cleanTables(db)` in beforeEach to reset state between tests.
 */
export async function getTestDB(): Promise<BrainDB> {
  if (!sharedDb) {
    // In-memory PGLite — no disk I/O, fastest possible
    const pg = new PGlite();
    sharedDb = new PGLiteDB(pg);
    await initPgSchema(sharedDb);
  }
  refCount++;
  return sharedDb;
}

/**
 * Truncate all tables to reset state between tests.
 * Much faster than dropping and recreating the database.
 */
export async function cleanTables(db: BrainDB): Promise<void> {
  await db.exec(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}

/**
 * Release the test DB. Closes when last consumer releases.
 */
export async function releaseTestDB(): Promise<void> {
  refCount--;
  if (refCount <= 0 && sharedDb) {
    await sharedDb.close();
    sharedDb = null;
    refCount = 0;
  }
}
