export type CommentLine = {
  line: number;
  text: string;
};

/**
 * Group scanned comment lines into blocks of contiguous line numbers, so a
 * comment spanning several lines is measured as one block.
 */
export function groupCommentBlocks(comments: CommentLine[]): CommentLine[][] {
  const blocks: CommentLine[][] = [];
  let current: CommentLine[] = [];
  let previousLine: number | undefined;

  for (const comment of comments) {
    if (previousLine !== undefined && comment.line === previousLine + 1) {
      current.push(comment);
    } else {
      if (current.length > 0) {
        blocks.push(current);
      }
      current = [comment];
    }
    previousLine = comment.line;
  }
  if (current.length > 0) {
    blocks.push(current);
  }

  return blocks;
}

/**
 * Extract human comment text from source lines. Handles `//`, `#`, `--`, and
 * `;` line comments plus `/*`-style block comments. Input lines may be
 * non-contiguous (for example, added lines from a diff); block-comment state
 * resets across line-number gaps so code after an unseen `*\/` is not
 * misread as a comment. A `/*` preceded by a quote character is treated as
 * string content, not a comment opener, to avoid cascading false positives.
 */
export function scanComments(lines: CommentLine[]): CommentLine[] {
  const comments: CommentLine[] = [];
  let inBlockComment = false;
  let previousLine: number | undefined;

  for (const { line, text } of lines) {
    if (previousLine !== undefined && line !== previousLine + 1) {
      inBlockComment = false;
    }
    previousLine = line;

    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#!")) {
      continue;
    }

    if (inBlockComment) {
      const content = trimmed
        .replace(/^\*\s?/, "")
        .replace(/\*\/.*$/, "")
        .trim();
      if (content) {
        comments.push({ line, text: content });
      }
      if (trimmed.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }

    const blockStart = trimmed.indexOf("/*");
    if (blockStart >= 0 && !/["'`]/.test(trimmed.slice(0, blockStart))) {
      const afterStart = trimmed.slice(blockStart + 2);
      const closes = afterStart.includes("*/");
      const content = afterStart.replace(/\*\/.*$/, "").trim();
      if (content) {
        comments.push({ line, text: content });
      }
      inBlockComment = !closes;
      continue;
    }

    const standalone = trimmed.match(/^(?:(?:\/\/+|#|--|;)\s?)(.+)$/);
    if (standalone?.[1]) {
      comments.push({ line, text: standalone[1].trim() });
    }
  }

  return comments;
}
