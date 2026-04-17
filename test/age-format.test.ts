import { describe, it, expect } from "vitest";
import { formatAge } from "../src/assembly/age-format.js";

describe("formatAge", () => {
  it("extracts YYYY-MM-DD from ISO-8601 timestamp", () => {
    expect(formatAge("2026-04-17T12:00:00.000Z")).toBe("2026-04-17");
    expect(formatAge("2025-01-03T08:29:00.000Z")).toBe("2025-01-03");
  });

  it("works with timestamps from new Date().toISOString()", () => {
    const now = new Date().toISOString();
    expect(formatAge(now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
