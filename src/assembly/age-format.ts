/**
 * Format a memory's capture date for context injection.
 * Returns the YYYY-MM-DD portion of an ISO-8601 timestamp.
 */
export function formatAge(createdAt: string): string {
  return createdAt.slice(0, 10);
}
