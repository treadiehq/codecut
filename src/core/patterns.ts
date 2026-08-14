export const DEFAULT_TEST_COMMAND_PATTERNS = [
  String.raw`(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$|:)`,
  String.raw`(?:^|[;&|]\s*|\s)(?:npx\s+)?vitest(?:\s|$)`,
  String.raw`(?:^|[;&|]\s*|\s)(?:python(?:3)?\s+-m\s+)?pytest(?:\s|$)`,
  String.raw`(?:^|[;&|]\s*|\s)cargo\s+test(?:\s|$)`,
  String.raw`(?:^|[;&|]\s*|\s)go\s+test(?:\s|$)`,
  String.raw`(?:^|[;&|]\s*|\s)(?:bundle\s+exec\s+)?rspec(?:\s|$)`,
  String.raw`(?:^|[;&|]\s*|\s)(?:dotnet\s+test|mvn\s+test|gradle\s+test)(?:\s|$)`,
];

export const DEFAULT_TEST_OUTPUT_PATTERNS = [
  String.raw`\bTest Files\s+[1-9]\d*\s+passed\b`,
  String.raw`\bTests:\s+[1-9]\d*\s+passed\b`,
  String.raw`\b[1-9]\d*\s+(?:tests?|specs?)\s+passed\b`,
  String.raw`(?:^|\s)[1-9]\d*\s+passed(?:\s|,|$)`,
  String.raw`\btest result:\s+ok\b`,
];

export const DEFAULT_VERIFICATION_COMMAND_PATTERNS = [
  ...DEFAULT_TEST_COMMAND_PATTERNS,
  String.raw`(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|typecheck|check|build)(?:\s|$|:)`,
  String.raw`(?:^|[;&|]\s*|\s)(?:npx\s+)?(?:eslint|tsc)(?:\s|$)`,
  String.raw`(?:^|[;&|]\s*|\s)(?:ruff|mypy|pyright)(?:\s|$)`,
  String.raw`(?:^|[;&|]\s*|\s)cargo\s+(?:check|clippy|build)(?:\s|$)`,
  String.raw`(?:^|[;&|]\s*|\s)go\s+(?:vet|build)(?:\s|$)`,
];

export const DEFAULT_WARNING_PATTERNS = [
  String.raw`(?:^|\s)(?:npm\s+warn|warning(?:\s+[A-Z]+\d+)?:|\[warn(?:ing)?\]|[A-Za-z]+Warning:)`,
  String.raw`\b[1-9]\d*\s+warnings?\b`,
  String.raw`\bdeprecated\b(?:\s+(?:API|option|feature|function|method|property)|:)`,
];

export const DEFAULT_REMOTE_COMMAND_PATTERNS = [
  String.raw`(?:^|[;&|]\s*|\s)ssh(?:\s|$)`,
  String.raw`(?:^|[;&|]\s*|\s)gh\s+(?:workflow\s+run|run\s+rerun)(?:\s|$)`,
  String.raw`(?:^|[;&|]\s*|\s)(?:circleci|buildkite-agent|actuate)\b`,
  String.raw`(?:^|[;&|]\s*|\s)kubectl\s+exec(?:\s|$)`,
];

export const DEFAULT_REMOTE_TOOL_PATTERNS = [
  String.raw`(?:remote|cloud|ci|runner)`,
];

export const DEFAULT_CODE_FILE_PATTERNS = [
  String.raw`\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|php|cs|cpp|cc|cxx|h|hpp|sql|sh|bash|zsh)$`,
];

export const LEGACY_COMMENT_CONTEXT_PATTERNS = [
  String.raw`\b(?:AGENTS|CLAUDE|GEMINI)\.md\b`,
  String.raw`\b(?:system\s+)?prompt\b`,
  String.raw`\b(?:agent\s+)?instructions?\b`,
  String.raw`\bdirectives?\b`,
  String.raw`\b[A-Z][A-Z0-9]{1,9}-\d+\b`,
  String.raw`(?:\.cursor/(?:plans|rules)|/tmp/|temporary\s+spec|ephemeral\s+spec)`,
  String.raw`\b(?:as\s+requested|per\s+(?:the\s+)?(?:prompt|instructions?)|the\s+agent|I\s+(?:added|changed|implemented))\b`,
];

export const DEFAULT_COMMENT_CONTEXT_PATTERNS = [
  String.raw`\b(?:AGENTS|CLAUDE|GEMINI)\.md\b`,
  String.raw`\b(?:system|agent)\s+prompt\b`,
  String.raw`\bagent\s+instructions?\b`,
  String.raw`\bcodecut\s+directives?\b`,
  String.raw`\b[A-Z][A-Z0-9]{1,9}-\d+\b`,
  String.raw`(?:\.cursor/(?:plans|rules)|/tmp/|temporary\s+spec|ephemeral\s+spec)`,
  String.raw`\b(?:as\s+requested|per\s+(?:the\s+)?(?:prompt|instructions?)|the\s+agent|I\s+(?:added|changed|implemented))\b`,
];

const CONSOLE_DEBUG_PATTERN =
  String.raw`(?<!#)\bconsole\.(?:log|debug|trace)\s*\(`;
const DEBUGGER_PATTERN =
  String.raw`(?<![#.\w$])debugger\s*;?\s*$`;
const PYTHON_PDB_PATTERN = String.raw`\bpdb\.set_trace\s*\(`;
const PYTHON_BREAKPOINT_PATTERN = String.raw`\bbreakpoint\s*\(\s*\)`;
const RUBY_PRY_PATTERN = String.raw`\bbinding\.pry\b`;
const RUBY_BYEBUG_PATTERN = String.raw`\bbyebug\b`;
const PHP_VAR_DUMP_PATTERN = String.raw`\bvar_dump\s*\(`;

export const DEFAULT_DEBUG_ARTIFACT_PATTERNS = [
  CONSOLE_DEBUG_PATTERN,
  DEBUGGER_PATTERN,
  PYTHON_PDB_PATTERN,
  PYTHON_BREAKPOINT_PATTERN,
  RUBY_PRY_PATTERN,
  RUBY_BYEBUG_PATTERN,
  PHP_VAR_DUMP_PATTERN,
];

export type SourceLanguage =
  | "javascript"
  | "python"
  | "ruby"
  | "php"
  | "shell"
  | "other";

export function sourceLanguageForPath(filePath: string): SourceLanguage {
  if (/\.[cm]?[jt]sx?$/i.test(filePath)) {
    return "javascript";
  }
  if (/\.py$/i.test(filePath)) {
    return "python";
  }
  if (/\.rb$/i.test(filePath)) {
    return "ruby";
  }
  if (/\.php$/i.test(filePath)) {
    return "php";
  }
  if (/\.(?:sh|bash|zsh)$/i.test(filePath)) {
    return "shell";
  }
  return "other";
}

const DEBUG_PATTERNS_BY_LANGUAGE: Record<SourceLanguage, readonly string[]> = {
  javascript: [CONSOLE_DEBUG_PATTERN, DEBUGGER_PATTERN],
  python: [PYTHON_PDB_PATTERN, PYTHON_BREAKPOINT_PATTERN],
  ruby: [RUBY_PRY_PATTERN, RUBY_BYEBUG_PATTERN],
  php: [PHP_VAR_DUMP_PATTERN],
  shell: [],
  other: [],
};

export function debugArtifactPatternsForPath(
  filePath: string,
  configuredPatterns: string[],
): string[] {
  const builtIns = new Set(DEFAULT_DEBUG_ARTIFACT_PATTERNS);
  const allowedBuiltIns = new Set(
    DEBUG_PATTERNS_BY_LANGUAGE[sourceLanguageForPath(filePath)],
  );
  return configuredPatterns.filter(
    (pattern) => !builtIns.has(pattern) || allowedBuiltIns.has(pattern),
  );
}

export const DEFAULT_TODO_PATTERNS = [
  String.raw`\b(?:TODO|FIXME|HACK|XXX)\b`,
];

export const DEFAULT_TEST_FILE_PATTERNS = [
  String.raw`(?:^|/)(?:tests?|__tests__|specs?)/`,
  String.raw`\.(?:test|spec)\.[cm]?[jt]sx?$`,
  String.raw`_test\.(?:go|py|rb|ts|js)$`,
];

export function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return false;
    }
  });
}

export function countWarningLines(
  output: string,
  warningPatterns: string[],
): number {
  let count = 0;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      trimmed.length === 0 ||
      /\b(?:0|no|without)\s+warnings?\b/i.test(trimmed)
    ) {
      continue;
    }

    if (matchesAny(trimmed, warningPatterns)) {
      count += 1;
    }
  }

  return count;
}
