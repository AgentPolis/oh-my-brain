/**
 * Minimal lockfile primitive for cross-process MEMORY.md writes.
 *
 * Why this exists: MEMORY.md is a shared artifact. Two agents running
 * concurrently — Claude Code Stop hook and Codex sync watcher, say — can
 * both try to read-modify-write it at the same time. Without a lock, the
 * second writer overwrites the first writer's changes and directives get
 * silently lost. For a product whose core promise is "never forget", that
 * is an unacceptable failure mode.
 *
 * Design:
 * - Lock file at `<path>.lock` containing PID + timestamp
 * - Acquire via O_EXCL create — atomic across processes on POSIX filesystems
 * - Stale lock detection: if the lock is older than STALE_MS and the owning
 *   PID no longer exists, steal it. This prevents a crashed process from
 *   permanently blocking the lock.
 * - Bounded retry loop with small sleeps (up to ~1s total)
 * - No external dependencies — everything is stdlib fs + process.kill(pid, 0)
 *
 * This is not a distributed lock. It is a local-filesystem best-effort lock,
 * which is exactly what MEMORY.md needs: the only writers are other local
 * processes on the same machine.
 */

import { existsSync, openSync, readFileSync, closeSync, writeSync, unlinkSync } from "fs";

const STALE_MS = 30_000;    // lock older than this is considered stale
const MAX_WAIT_MS = 2_000;  // give up after this long waiting for a busy lock
const RETRY_MS = 25;        // sleep between retries

function sleepSync(ms: number): void {
  // Busy-wait is acceptable here: lock contention is rare and brief, and
  // we deliberately avoid async just so callers (which are sync fs code
  // paths) don't have to be refactored into async everywhere.
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Spin. Intentionally tight because ms is small (25ms default).
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface LockPayload {
  pid: number;
  ts: number;
}

function readLockPayload(lockPath: string): LockPayload | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as LockPayload;
    if (typeof parsed.pid === "number" && typeof parsed.ts === "number") {
      return parsed;
    }
  } catch {
    // Corrupted lock body — treat as stale.
  }
  return null;
}

function tryCreateLock(lockPath: string): boolean {
  try {
    // O_EXCL | O_CREAT | O_WRONLY — fails if file already exists
    const fd = openSync(lockPath, "wx");
    const payload: LockPayload = { pid: process.pid, ts: Date.now() };
    writeSync(fd, JSON.stringify(payload));
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function stealStaleLock(lockPath: string): void {
  const payload = readLockPayload(lockPath);
  const age = payload ? Date.now() - payload.ts : Infinity;
  const ownerAlive = payload ? isProcessAlive(payload.pid) : false;

  if (age > STALE_MS || !ownerAlive) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Someone else beat us to it. That's fine — next acquire attempt will
      // either succeed or re-enter this path.
    }
  }
}

/**
 * Acquire a lock on `path`. Blocks (synchronously) for up to MAX_WAIT_MS.
 * Returns a release function that removes the lock file. If the lock cannot
 * be acquired within the timeout, throws. Callers in the hook path should
 * catch and fall back to best-effort (write without lock, log a warning)
 * rather than failing the user's session.
 */
export function acquireLock(path: string): () => void {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    if (tryCreateLock(lockPath)) {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(lockPath);
        } catch {
          // Lock file may already be gone (stolen as stale, or unlinked
          // by another release). Not fatal.
        }
      };
    }

    // Lock file exists — check if it's stale and can be stolen
    if (existsSync(lockPath)) {
      stealStaleLock(lockPath);
    }

    sleepSync(RETRY_MS);
  }

  throw new Error(
    `Could not acquire lock on ${lockPath} within ${MAX_WAIT_MS}ms. ` +
      `Another process may be writing to the same file.`
  );
}

/**
 * Run a synchronous function under the lock. Release is automatic, even if
 * the function throws.
 */
export function withLock<T>(path: string, fn: () => T): T {
  const release = acquireLock(path);
  try {
    return fn();
  } finally {
    release();
  }
}
