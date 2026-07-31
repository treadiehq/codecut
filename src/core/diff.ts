export type AddedLine = {
  line: number;
  text: string;
};

export type FileDiff = {
  path: string;
  addedLines: AddedLine[];
  added: number;
  deleted: number;
  binary: boolean;
};

function headerPath(line: string): string {
  const quoted = line.match(/ "b\/(.+)"$/);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const plain = line.match(/ b\/(.+)$/);
  return plain?.[1] ?? "unknown";
}

function newFilePath(line: string): string | undefined {
  const value = (line.slice(4).split("\t")[0] ?? "").trim();
  if (value.length === 0 || value === "/dev/null") {
    return undefined;
  }
  const unquoted =
    value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value;
  return unquoted.replace(/^b\//, "");
}

/**
 * Parse a unified diff (git or plain `diff -u` format) into per-file added
 * lines with their line numbers in the new file, plus added/deleted counts.
 * Hunk line counts from `@@` headers separate content from header lines, so
 * added lines that start with `+++` or `---` are never misread as headers.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let sawNewFileHeader = false;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  const startFile = (path: string): void => {
    current = { path, addedLines: [], added: 0, deleted: 0, binary: false };
    files.push(current);
    sawNewFileHeader = false;
    newLine = 0;
    oldRemaining = 0;
    newRemaining = 0;
  };

  for (const line of diff.split(/\r?\n/)) {
    const inHunk = oldRemaining > 0 || newRemaining > 0;

    if (current && inHunk) {
      if (line.startsWith("\\")) {
        continue;
      }
      if (line.startsWith("+")) {
        current.addedLines.push({ line: newLine, text: line.slice(1) });
        current.added += 1;
        newLine += 1;
        newRemaining -= 1;
        continue;
      }
      if (line.startsWith("-")) {
        current.deleted += 1;
        oldRemaining -= 1;
        continue;
      }
      newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
      continue;
    }

    if (line.startsWith("diff --git ")) {
      startFile(headerPath(line));
      continue;
    }

    if (line.startsWith("+++ ")) {
      const path = newFilePath(line);
      if (!current || sawNewFileHeader) {
        startFile(path ?? "unknown");
      } else if (path) {
        current.path = path;
      }
      sawNewFileHeader = true;
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk?.[2]) {
      newLine = Number.parseInt(hunk[2], 10);
      oldRemaining = hunk[1] === undefined ? 1 : Number.parseInt(hunk[1], 10);
      newRemaining = hunk[3] === undefined ? 1 : Number.parseInt(hunk[3], 10);
    }
  }

  return files;
}

export function diffTotals(files: FileDiff[]): {
  files: number;
  added: number;
  deleted: number;
} {
  return {
    files: files.length,
    added: files.reduce((total, file) => total + file.added, 0),
    deleted: files.reduce((total, file) => total + file.deleted, 0),
  };
}
