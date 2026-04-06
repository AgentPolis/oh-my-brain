import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireLock, withLock } from "../cli/lockfile.js";

describe("lockfile", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ohmybrain-lock-"));
    target = join(dir, "MEMORY.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires and releases a lock", () => {
    const release = acquireLock(target);
    expect(existsSync(`${target}.lock`)).toBe(true);
    release();
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("release is idempotent", () => {
    const release = acquireLock(target);
    release();
    // Second call should not throw, even though the lock file is gone.
    expect(() => release()).not.toThrow();
  });

  it("withLock runs the function and releases on success", () => {
    const result = withLock(target, () => {
      expect(existsSync(`${target}.lock`)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("withLock releases on throw", () => {
    expect(() =>
      withLock(target, () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("steals a stale lock (old timestamp + dead pid)", () => {
    // Plant a stale lock file: very old timestamp, pid that cannot exist.
    // Using pid 999999999 which is well above any plausible live pid; if
    // this ever becomes a live pid in CI we can revisit.
    const ancientTs = Date.now() - 60_000; // 60s ago, past STALE_MS
    writeFileSync(
      `${target}.lock`,
      JSON.stringify({ pid: 999999999, ts: ancientTs })
    );
    const release = acquireLock(target);
    expect(existsSync(`${target}.lock`)).toBe(true);
    release();
  });

  it("serializes two sequential withLock calls", () => {
    // We can't easily test true concurrency in a single Node process, but
    // we can at least verify that back-to-back acquire + release works.
    const values: number[] = [];
    withLock(target, () => values.push(1));
    withLock(target, () => values.push(2));
    withLock(target, () => values.push(3));
    expect(values).toEqual([1, 2, 3]);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });
});
