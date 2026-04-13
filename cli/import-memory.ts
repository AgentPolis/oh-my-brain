import { readFileSync } from "fs";

export function parseActiveDirectives(memoryPath: string): string[] {
  const content = readFileSync(memoryPath, "utf8");
  const lines = content.split("\n");
  const directives: string[] = [];
  let inArchive = false;
  const archiveHeading = "## oh-my-brain archive (superseded directives — do not use)";

  for (const line of lines) {
    if (line.trim() === archiveHeading) {
      inArchive = true;
      continue;
    }
    if (inArchive) {
      if (/^## /.test(line) && line.trim() !== archiveHeading) {
        inArchive = false;
      } else {
        continue;
      }
    }

    const match = line.match(/^-\s+\[[^\]]*\]\s+(.+)$/);
    if (match) directives.push(match[1].trim());
  }

  return directives;
}
