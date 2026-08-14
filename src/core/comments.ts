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

type ExecutableContext =
  | { kind: "code" }
  | { kind: "string"; quote: '"' | "'"; escaped: boolean }
  | { kind: "template"; escaped: boolean }
  | { kind: "template-expression"; braceDepth: number };

export type HashCommentMode =
  | "anywhere"
  | "php"
  | "whitespace"
  | "never";

/**
 * Keep executable source text while removing comments and string contents.
 * Template text is removed while `${...}` expressions remain executable.
 * Scanner state carries across contiguous added lines, but resets across diff
 * gaps where unseen source may have closed an open construct.
 */
export function stripNonExecutableText(
  lines: CommentLine[],
  options: { hashComments?: HashCommentMode } = {},
): CommentLine[] {
  const codeLines: CommentLine[] = [];
  const hashComments = options.hashComments ?? "whitespace";
  let contexts: ExecutableContext[] = [{ kind: "code" }];
  let inBlockComment = false;
  let previousLine: number | undefined;

  for (const { line, text } of lines) {
    if (previousLine !== undefined && line !== previousLine + 1) {
      inBlockComment = false;
      contexts = [{ kind: "code" }];
    }
    previousLine = line;

    for (const context of contexts) {
      if (context.kind === "string" || context.kind === "template") {
        context.escaped = false;
      }
    }

    let code = "";

    for (let index = 0; index < text.length; index += 1) {
      const current = text[index];
      const next = text[index + 1];
      const context = contexts.at(-1) ?? { kind: "code" };

      if (inBlockComment) {
        if (current === "*" && next === "/") {
          inBlockComment = false;
          index += 1;
        }
        continue;
      }

      if (context.kind === "string") {
        if (context.escaped) {
          context.escaped = false;
        } else if (current === "\\") {
          context.escaped = true;
        } else if (current === context.quote) {
          code += current;
          contexts.pop();
        }
        continue;
      }

      if (context.kind === "template") {
        if (context.escaped) {
          context.escaped = false;
        } else if (current === "\\") {
          context.escaped = true;
        } else if (current === "`") {
          code += current;
          contexts.pop();
        } else if (current === "$" && next === "{") {
          code += "${";
          contexts.push({ kind: "template-expression", braceDepth: 0 });
          index += 1;
        }
        continue;
      }

      if (current === '"' || current === "'") {
        code += current;
        contexts.push({ kind: "string", quote: current, escaped: false });
        continue;
      }
      if (current === "`") {
        code += current;
        contexts.push({ kind: "template", escaped: false });
        continue;
      }
      if (current === "/" && next === "*") {
        inBlockComment = true;
        index += 1;
        continue;
      }
      if (current === "/" && next === "/") {
        break;
      }
      if (current === "#") {
        const startsHashComment =
          (next === "!" && index === 0) ||
          hashComments === "anywhere" ||
          (hashComments === "php" && next !== "[") ||
          (hashComments === "whitespace" &&
            (index === 0 || /\s/.test(text[index - 1] ?? "")));
        if (startsHashComment) {
          break;
        }
      }
      if (
        current === "-" &&
        next === "-" &&
        (text[index + 2] === undefined || /\s/.test(text[index + 2] ?? ""))
      ) {
        break;
      }
      if (context.kind === "template-expression") {
        if (current === "{") {
          context.braceDepth += 1;
        } else if (current === "}") {
          if (context.braceDepth === 0) {
            code += current;
            contexts.pop();
            continue;
          }
          context.braceDepth -= 1;
        }
      }

      code += current;
    }

    codeLines.push({ line, text: code });
  }

  return codeLines;
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

    const standalone = trimmed.match(/^(?:(?:\/\/+|#|--|;)\s?)(.+)$/);
    if (standalone?.[1]) {
      comments.push({ line, text: standalone[1].trim() });
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
  }

  return comments;
}
