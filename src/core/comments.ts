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
  | { kind: "template-expression"; braceDepth: number }
  | { kind: "regex"; escaped: boolean; inCharacterClass: boolean };

export type HashCommentMode =
  | "anywhere"
  | "php"
  | "whitespace"
  | "never";

export type CommentScanOptions = {
  hashComments?: HashCommentMode;
  dashComments?: boolean;
  regexLiterals?: boolean;
};

function canStartRegexLiteral(code: string): boolean {
  const before = code.trimEnd();
  if (before.length === 0) {
    return true;
  }
  if (/(?:\+\+|--)$/.test(before)) {
    return false;
  }
  if (
    /(?:=>|\b(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield))$/.test(
      before,
    )
  ) {
    return true;
  }
  return /[([{=,:;!&|?+\-*%^~]$/.test(before);
}

/**
 * Keep executable source text while removing comments and string contents.
 * Template and regex literal text is removed while `${...}` expressions
 * remain executable.
 * Scanner state carries across contiguous added lines, but resets across diff
 * gaps where unseen source may have closed an open construct.
 */
function analyzeSourceLines(
  lines: CommentLine[],
  options: CommentScanOptions = {},
): { codeLines: CommentLine[]; commentLines: CommentLine[] } {
  const codeLines: CommentLine[] = [];
  const commentLines: CommentLine[] = [];
  const hashComments = options.hashComments ?? "whitespace";
  const dashComments = options.dashComments ?? true;
  const regexLiterals = options.regexLiterals ?? true;
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
    let hasComment = inBlockComment && text.trim().length > 0;

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

      if (context.kind === "regex") {
        if (context.escaped) {
          context.escaped = false;
        } else if (current === "\\") {
          context.escaped = true;
        } else if (current === "[" && !context.inCharacterClass) {
          context.inCharacterClass = true;
        } else if (current === "]" && context.inCharacterClass) {
          context.inCharacterClass = false;
        } else if (current === "/" && !context.inCharacterClass) {
          code += current;
          contexts.pop();
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
        hasComment = true;
        inBlockComment = true;
        index += 1;
        continue;
      }
      if (current === "/" && next === "/") {
        hasComment = true;
        break;
      }
      if (
        regexLiterals &&
        current === "/" &&
        canStartRegexLiteral(code)
      ) {
        code += current;
        contexts.push({
          kind: "regex",
          escaped: false,
          inCharacterClass: false,
        });
        continue;
      }
      if (current === "#") {
        const startsHashComment =
          (next === "!" && index === 0) ||
          hashComments === "anywhere" ||
          (hashComments === "php" && next !== "[") ||
          (hashComments === "whitespace" &&
            (index === 0 || /\s/.test(text[index - 1] ?? "")));
        if (startsHashComment) {
          hasComment = !(next === "!" && index === 0);
          break;
        }
      }
      if (
        dashComments &&
        current === "-" &&
        next === "-" &&
        (text[index + 2] === undefined || /\s/.test(text[index + 2] ?? ""))
      ) {
        hasComment = true;
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

    if (contexts.at(-1)?.kind === "regex") {
      contexts.pop();
    }
    codeLines.push({ line, text: code });
    if (hasComment && text.trim().length > 0) {
      commentLines.push({ line, text });
    }
  }

  return { codeLines, commentLines };
}

export function stripNonExecutableText(
  lines: CommentLine[],
  options: CommentScanOptions = {},
): CommentLine[] {
  return analyzeSourceLines(lines, options).codeLines;
}

/**
 * Return each non-blank source line that contains comment syntax. Unlike
 * scanComments, this includes delimiters and inline comments because density
 * is based on changed lines rather than extracted human text.
 */
export function scanCommentLines(
  lines: CommentLine[],
  options: CommentScanOptions = {},
): CommentLine[] {
  return analyzeSourceLines(lines, options).commentLines;
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
