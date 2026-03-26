/**
 * Session simulator — generates realistic multi-turn conversations
 * for benchmarking squeeze-claw vs baseline (keep-everything).
 *
 * Run: npx tsx eval/simulate-session.ts
 */

import type { Message } from "../src/types.js";

/** A simulated session with mixed content types */
export interface SimulatedSession {
  name: string;
  description: string;
  messages: Message[];
}

/**
 * Generate a coding-heavy session (50 turns).
 * Lots of tool results, code blocks, and acks.
 */
export function codingSession(): SimulatedSession {
  const messages: Message[] = [];

  // Turn 1: directive
  messages.push({ role: "user", content: "Always use TypeScript and never use any. From now on, write tests for every function." });
  messages.push({ role: "assistant", content: "Got it — TypeScript only, no `any`, tests for every function." });

  // Turn 2: preference
  messages.push({ role: "user", content: "I prefer functional style over classes when possible." });
  messages.push({ role: "assistant", content: "Noted. I'll use functions and composition." });

  // Turns 3-10: tool-heavy coding
  for (let i = 3; i <= 10; i++) {
    messages.push({ role: "user", content: `Fix the bug in src/handlers/auth.ts line ${i * 10}` });
    messages.push({ role: "tool", content: generateToolResult(i) });
    messages.push({ role: "assistant", content: `Found the issue on line ${i * 10}. The problem is a missing null check. Here's the fix:\n\`\`\`typescript\nif (!user) throw new AuthError('not found');\n\`\`\`` });
    messages.push({ role: "user", content: "ok" }); // L0 noise
  }

  // Turns 11-15: more coding with acks
  for (let i = 11; i <= 15; i++) {
    messages.push({ role: "user", content: `Now update the test file for handler ${i}` });
    messages.push({ role: "tool", content: `File created successfully at test/handler-${i}.test.ts` }); // L0 noise
    messages.push({ role: "assistant", content: `Test file created with ${i} test cases covering edge cases.` });
    messages.push({ role: "user", content: "thanks" }); // L0 noise
  }

  // Turns 16-25: debugging
  for (let i = 16; i <= 25; i++) {
    messages.push({ role: "user", content: `The test on line ${i * 5} is failing` });
    messages.push({ role: "tool", content: `Error: TypeError: Cannot read properties of undefined (reading 'id')\n    at Object.<anonymous> (test/handler.test.ts:${i * 5}:15)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)` });
    messages.push({ role: "assistant", content: "The mock setup is missing the `id` field. Let me fix it." });
    messages.push({ role: "tool", content: "The file /test/handler.test.ts has been updated successfully" }); // L0 noise
    messages.push({ role: "user", content: "got it" }); // L0 noise
  }

  // Turns 26-30: planning
  for (let i = 26; i <= 30; i++) {
    messages.push({ role: "user", content: `What should we do next for the auth module?` });
    messages.push({ role: "assistant", content: `I recommend three steps:\n1. Add rate limiting\n2. Implement refresh tokens\n3. Add audit logging\n\nShall I start with rate limiting?` });
    messages.push({ role: "user", content: "sure" }); // L0 noise
  }

  // Turns 31-40: more coding
  for (let i = 31; i <= 40; i++) {
    messages.push({ role: "user", content: `Implement the rate limiter in src/middleware/rate-limit.ts` });
    messages.push({ role: "tool", content: generateLargeToolResult() });
    messages.push({ role: "assistant", content: `\`\`\`typescript\nexport function rateLimit(opts: RateLimitOptions) {\n  const store = new Map<string, number[]>();\n  return (req: Request) => {\n    const key = req.ip;\n    const now = Date.now();\n    const hits = store.get(key)?.filter(t => t > now - opts.windowMs) ?? [];\n    if (hits.length >= opts.max) throw new RateLimitError();\n    hits.push(now);\n    store.set(key, hits);\n  };\n}\n\`\`\`` });
    messages.push({ role: "user", content: "nice" }); // L0 noise
  }

  // Turns 41-45: reference another directive
  messages.push({ role: "user", content: "Remember that our API rate limit should be 100 req/min for free tier." });
  messages.push({ role: "assistant", content: "Noted — 100 req/min for free tier." });

  for (let i = 42; i <= 45; i++) {
    messages.push({ role: "user", content: `Apply the rate limit to the ${i === 42 ? 'auth' : i === 43 ? 'trading' : 'data'} endpoint` });
    messages.push({ role: "assistant", content: `Applied rate limit of 100 req/min to the endpoint.` });
    messages.push({ role: "user", content: "perfect" }); // L0 noise
  }

  // Turns 46-50: wrap up
  for (let i = 46; i <= 50; i++) {
    messages.push({ role: "user", content: `Run all tests` });
    messages.push({ role: "tool", content: `✓ 48 tests passed\n✗ 2 tests failed\n\nFailing:\n  - rate-limit.test.ts:${i}: expected 429 but got 200\n  - auth.test.ts:${i + 10}: timeout after 5000ms` });
    messages.push({ role: "assistant", content: "Two failures. The rate limit test needs to wait for the window to fill. The auth test has a timeout — likely missing await." });
    messages.push({ role: "user", content: "ok" }); // L0 noise
  }

  return {
    name: "coding-50-turns",
    description: "50-turn coding session with debugging, planning, and tool usage",
    messages,
  };
}

/**
 * Generate a session with lots of noise and repetition.
 * Worst case for baseline (keep-everything), best case for squeeze.
 */
export function noisySession(): SimulatedSession {
  const messages: Message[] = [];

  // 1 directive at the start
  messages.push({ role: "user", content: "Never delete files without asking me first." });
  messages.push({ role: "assistant", content: "Understood — I'll always confirm before deleting." });

  // 80% noise
  for (let i = 0; i < 80; i++) {
    const noiseType = i % 4;
    if (noiseType === 0) {
      messages.push({ role: "user", content: "ok" });
    } else if (noiseType === 1) {
      messages.push({ role: "tool", content: "File created successfully at /tmp/foo.ts" });
    } else if (noiseType === 2) {
      messages.push({ role: "tool", content: "(Bash completed with no output)" });
    } else {
      messages.push({ role: "user", content: "got it" });
    }

    // Actual content every 5 messages
    if (i % 5 === 0) {
      messages.push({ role: "user", content: `Update the config for service ${i / 5}` });
      messages.push({ role: "assistant", content: `Updated service ${i / 5} configuration with the new settings.` });
    }
  }

  // Directive at the end — should survive
  messages.push({ role: "user", content: "Always validate input before processing." });
  messages.push({ role: "assistant", content: "Will do — input validation first." });

  return {
    name: "noisy-session",
    description: "80% noise messages — worst case for keep-everything",
    messages,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function generateToolResult(seed: number): string {
  return `     1→import { describe, it, expect } from 'vitest';
     2→import { authHandler } from '../src/handlers/auth';
     3→
     4→describe('authHandler', () => {
     ${Array.from({ length: 15 }, (_, i) =>
   `  ${i + 5}→  it('should handle case ${seed * 10 + i}', () => {\n   ${i + 5}→    expect(authHandler(${seed})).toBeDefined();\n   ${i + 5}→  });`
 ).join("\n")}
   20→});`;
}

function generateLargeToolResult(): string {
  return Array.from({ length: 30 }, (_, i) =>
    `   ${i + 1}→ const handler${i} = async (req: Request) => { return Response.json({ ok: true, id: ${i} }); };`
  ).join("\n");
}
