import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteDB, pgliteFactory } from "../src/storage/db.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("PGLiteDB", () => {
  it("reports the pglite engine", async () => {
    const db = new PGLiteDB(new PGlite(makeTempDir("pglite-engine-")));
    expect(db.engine).toBe("pglite");
    await db.close();
  });

  it("exec creates tables and query reads them back", async () => {
    const db = await pgliteFactory.create(makeTempDir("pglite-create-"));
    await db.exec("CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)");
    await db.exec("INSERT INTO items (name) VALUES ($1)", ["alpha"]);

    const rows = await db.query<{ id: number; name: string }>(
      "SELECT id, name FROM items ORDER BY id"
    );

    expect(rows).toEqual([{ id: 1, name: "alpha" }]);
    await db.close();
  });

  it("supports parameterized queries", async () => {
    const db = await pgliteFactory.create(makeTempDir("pglite-query-"));
    await db.exec("CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)");
    await db.exec("INSERT INTO items (name) VALUES ($1), ($2)", ["alpha", "beta"]);

    const rows = await db.query<{ name: string }>(
      "SELECT name FROM items WHERE name = $1",
      ["beta"],
    );

    expect(rows).toEqual([{ name: "beta" }]);
    await db.close();
  });

  it("supports exec without params for multi-statement setup", async () => {
    const db = await pgliteFactory.create(makeTempDir("pglite-multistmt-"));
    await db.exec(`
      CREATE TABLE numbers (value INTEGER NOT NULL);
      INSERT INTO numbers (value) VALUES (1);
      INSERT INTO numbers (value) VALUES (2);
    `);

    const rows = await db.query<{ value: number }>("SELECT value FROM numbers ORDER BY value");
    expect(rows.map((row) => row.value)).toEqual([1, 2]);
    await db.close();
  });

  it("commits transactions when the callback succeeds", async () => {
    const db = await pgliteFactory.create(makeTempDir("pglite-commit-"));
    await db.exec("CREATE TABLE items (name TEXT NOT NULL)");

    await db.transaction(async (tx) => {
      await tx.exec("INSERT INTO items (name) VALUES ($1)", ["alpha"]);
      await tx.exec("INSERT INTO items (name) VALUES ($1)", ["beta"]);
    });

    const rows = await db.query<{ name: string }>("SELECT name FROM items ORDER BY name");
    expect(rows.map((row) => row.name)).toEqual(["alpha", "beta"]);
    await db.close();
  });

  it("rolls back transactions when the callback throws", async () => {
    const db = await pgliteFactory.create(makeTempDir("pglite-rollback-"));
    await db.exec("CREATE TABLE items (name TEXT NOT NULL)");

    await expect(
      db.transaction(async (tx) => {
        await tx.exec("INSERT INTO items (name) VALUES ($1)", ["alpha"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await db.query<{ name: string }>("SELECT name FROM items");
    expect(rows).toEqual([]);
    await db.close();
  });

  it("reuses the transaction wrapper for nested transactions", async () => {
    const db = await pgliteFactory.create(makeTempDir("pglite-nested-"));
    await db.exec("CREATE TABLE items (name TEXT NOT NULL)");

    await db.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.exec("INSERT INTO items (name) VALUES ($1)", ["alpha"]);
      });
    });

    const rows = await db.query<{ name: string }>("SELECT name FROM items");
    expect(rows).toEqual([{ name: "alpha" }]);
    await db.close();
  });

  it("persists data when reopening the same directory", async () => {
    const dir = makeTempDir("pglite-persist-");
    const db1 = await pgliteFactory.create(dir);
    await db1.exec("CREATE TABLE items (name TEXT NOT NULL)");
    await db1.exec("INSERT INTO items (name) VALUES ($1)", ["alpha"]);
    await db1.close();

    const db2 = await pgliteFactory.create(dir);
    const rows = await db2.query<{ name: string }>("SELECT name FROM items");
    expect(rows).toEqual([{ name: "alpha" }]);
    await db2.close();
  });
});
