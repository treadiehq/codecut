import { createHash } from "node:crypto";
import { SUPPORTED_AGENT_NAMES } from "./agents.js";
import {
  DEFAULT_MAX_COMMENT_PERCENTAGE,
  DEFAULT_MIN_ADDED_LINES_FOR_COMMENT_PERCENTAGE,
} from "./comment-density.js";
import {
  DEFAULT_CODE_FILE_PATTERNS,
  DEFAULT_COMMENT_CONTEXT_PATTERNS,
  DEFAULT_REMOTE_COMMAND_PATTERNS,
  DEFAULT_REMOTE_TOOL_PATTERNS,
  DEFAULT_TEST_COMMAND_PATTERNS,
  DEFAULT_TEST_OUTPUT_PATTERNS,
  DEFAULT_VERIFICATION_COMMAND_PATTERNS,
  DEFAULT_WARNING_PATTERNS,
} from "./patterns.js";
import {
  LINT_CHECKS,
  type AgentName,
  type Directive,
  type Policy,
  type PolicyRule,
} from "./schema.js";

const STARTER_DIRECTIVES: Directive[] = [
  {
    text: "Treat warnings as errors",
    source: {
      path: "starter policy",
      scope: "generated",
      conditional: false,
    },
  },
  {
    text: "All unit tests must pass",
    source: {
      path: "starter policy",
      scope: "generated",
      conditional: false,
    },
  },
  {
    text: "Keep changes small and focused",
    source: {
      path: "starter policy",
      scope: "generated",
      conditional: false,
    },
  },
  {
    text: "Verify your work",
    source: {
      path: "starter policy",
      scope: "generated",
      conditional: false,
    },
  },
  {
    text: "Run tests locally",
    source: {
      path: "starter policy",
      scope: "generated",
      conditional: false,
    },
  },
  {
    text: `Keep prompts, agent instructions, tickets, and temporary files out of code comments; preserve comments for lasting constraints and keep comment lines below ${DEFAULT_MAX_COMMENT_PERCENTAGE}% of added source lines`,
    source: {
      path: "starter policy",
      scope: "generated",
      conditional: false,
    },
  },
];

function ruleId(type: PolicyRule["type"], directive: string): string {
  const digest = createHash("sha256")
    .update(`${type}:${directive.toLowerCase()}`)
    .digest("hex")
    .slice(0, 8);
  return `${type}-${digest}`;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

function parseCommentLineLimit(normalized: string): number | undefined {
  const explicit = normalized.match(
    /\b(?:longer|more)\s+than\s+(one|two|three|four|five|\d+)\s+lines?\b/,
  );
  if (explicit?.[1]) {
    const limit = NUMBER_WORDS[explicit[1]] ?? Number.parseInt(explicit[1], 10);
    return Number.isInteger(limit) && limit > 0 ? limit : undefined;
  }
  if (/\bmulti[\s-]?line\s+comments?\b/.test(normalized)) {
    return 1;
  }
  return undefined;
}

function parseCommentPercentageLimit(normalized: string): number | undefined {
  const explicit = normalized.match(
    /\bcomment(?:s|\s+lines?)?\b.{0,100}?\b(?:below|under|less\s+than|at\s+most|no\s+more\s+than)\s+(\d+(?:\.\d+)?)\s*(?:%|\bpercent\b)/,
  );
  if (!explicit?.[1]) {
    return undefined;
  }
  const limit = Number.parseFloat(explicit[1]);
  return Number.isFinite(limit) && limit >= 0 && limit <= 100
    ? limit
    : undefined;
}

function hasInlineScope(normalized: string): boolean {
  return /^(?:for|while)\b|\b(?:if|when|whenever|unless|except)\b|\bonly\s+(?:if|when|for|in|on|during)\b|\bfor\s+(?:release|production|generated|documentation|docs?|migrations?|windows|linux|macos|ci)\b/.test(
    normalized,
  );
}

function hasNegation(normalized: string): boolean {
  return /\b(?:not|never|do not|don't|cannot|can't|must not|should not|need not)\b/.test(
    normalized,
  );
}

function hasCompoundStructure(normalized: string): boolean {
  return (
    /\b(?:and|or|but)\b/.test(normalized) ||
    /[;,.!?]\s+[a-z]/.test(normalized)
  );
}

function classifyDirective(
  directive: Directive,
  acceptBlockingRules: boolean,
): PolicyRule {
  const normalized = directive.text.toLowerCase();
  if (directive.source.conditional) {
    return {
      id: ruleId("advisory", directive.text),
      type: "advisory",
      directive: directive.text,
      source: directive.source,
      mode: "warn",
      confirmed: true,
      enabled: true,
    };
  }

  const warningRule =
    !/\b(?:allow|ignore|except|exclude)\b.*\bwarnings?\b|\bwarnings?\b.*\b(?:may|can)\b/i.test(
      normalized,
    ) &&
    /\b(?:treat|consider)\s+(?:(?:all|any|the)\s+)?warnings?\b.*(?:as\s+)?errors?\b|\bfail(?:ure)?\s+on\s+warnings?\b|\bno\s+warnings?\b/i.test(
      normalized,
    );
  const passingTestRule =
    /\b(?:all\s+)?(?:unit\s+)?tests?\s+(?:must\s+)?pass\b/.test(normalized);
  const localTestRule =
    /\blocal(?:ly)?\b.*\btest|\btest.*\blocal(?:ly)?\b/.test(normalized);
  const blastRadiusRule =
    /\bblast\s+radius\b|\bhigh[\s-]+confidence\b|\bchanges?\b.*\b(?:small|focused)\b/.test(
      normalized,
    );
  const verificationRule =
    /\bverify\b|\bdon't assume\b|\bdo not assume\b/.test(normalized);
  const readyGithubPrRule =
    /\b(?:pr|pull request)\b/.test(normalized) &&
    /\b(?:non[\s-]?draft|ready for review|mark(?:ed)?\s+(?:the\s+)?(?:pr|pull request)\s+ready|not\s+(?:be\s+)?(?:a\s+)?draft)\b/.test(
      normalized,
    ) &&
    /\b(?:open|create|ensure|must|should|required?|mark|make|keep)\b/.test(
      normalized,
    );
  const cleanPushRule =
    /\b(?:git\s+)?push(?:es|ing)?\b/.test(normalized) &&
    /\b(?:codecut\s+lint|lint|checks?)\b/.test(normalized) &&
    /\b(?:clean|pass(?:es|ing)?|block|prevent|stop|issues?|findings?)\b/.test(
      normalized,
    );
  const commentRule = /\bcomments?\b/.test(normalized);
  const categoryCount = [
    warningRule,
    passingTestRule,
    localTestRule,
    blastRadiusRule,
    verificationRule,
    readyGithubPrRule,
    cleanPushRule,
    commentRule,
  ].filter(Boolean).length;
  if (categoryCount > 1 && hasCompoundStructure(normalized)) {
    return {
      id: ruleId("advisory", directive.text),
      type: "advisory",
      directive: directive.text,
      source: directive.source,
      mode: "warn",
      confirmed: true,
      enabled: true,
    };
  }
  const unsafeForBlockingInference =
    (hasNegation(normalized) && !readyGithubPrRule) ||
    hasInlineScope(normalized);
  const blockingRule = unsafeForBlockingInference
    ? undefined
    : warningRule
      ? {
          type: "warnings-as-errors" as const,
          commandPatterns: DEFAULT_VERIFICATION_COMMAND_PATTERNS,
          warningPatterns: DEFAULT_WARNING_PATTERNS,
        }
      : passingTestRule
        ? {
            type: "require-passing-tests" as const,
            commandPatterns: DEFAULT_TEST_COMMAND_PATTERNS,
            testOutputPatterns: DEFAULT_TEST_OUTPUT_PATTERNS,
          }
        : localTestRule
          ? {
              type: "local-testing" as const,
              testCommandPatterns: DEFAULT_TEST_COMMAND_PATTERNS,
              remoteCommandPatterns: DEFAULT_REMOTE_COMMAND_PATTERNS,
              remoteToolPatterns: DEFAULT_REMOTE_TOOL_PATTERNS,
            }
          : readyGithubPrRule
            ? {
                type: "require-ready-github-pr" as const,
              }
            : cleanPushRule
              ? {
                  type: "require-clean-push" as const,
                  checks: [...LINT_CHECKS],
                }
              : undefined;

  if (blockingRule) {
    return {
      id: ruleId(blockingRule.type, directive.text),
      directive: directive.text,
      source: directive.source,
      mode: "block",
      confirmed: acceptBlockingRules,
      enabled: true,
      ...blockingRule,
    };
  }

  if (
    !unsafeForBlockingInference &&
    blastRadiusRule
  ) {
    return {
      id: ruleId("blast-radius", directive.text),
      type: "blast-radius",
      directive: directive.text,
      source: directive.source,
      mode: "warn",
      confirmed: true,
      enabled: true,
      maxFiles: 12,
      maxChangedLines: 500,
    };
  }

  const negatedVerification =
    /\b(?:do not|don't|never|need not|not required to|should not|must not|cannot|can't)\s+verify\b/.test(
      normalized,
    );
  if (
    !hasInlineScope(normalized) &&
    ((!negatedVerification && /\bverify\b/.test(normalized)) ||
      /\bdon't assume\b|\bdo not assume\b/.test(normalized))
  ) {
    return {
      id: ruleId("verification-evidence", directive.text),
      type: "verification-evidence",
      directive: directive.text,
      source: directive.source,
      mode: "warn",
      confirmed: true,
      enabled: true,
      commandPatterns: DEFAULT_VERIFICATION_COMMAND_PATTERNS,
    };
  }

  const permissiveCommentGuidance =
    /\bcomments?\b.*\b(?:may|can|need not|do not need|don't need|not required)\b|\b(?:allow|ignore|exclude|except)\b.*\bcomments?\b/.test(
      normalized,
    );
  if (
    /\bcomments?\b/.test(normalized) &&
    !hasInlineScope(normalized) &&
    !permissiveCommentGuidance
  ) {
    const maxCommentLines = parseCommentLineLimit(normalized);
    const maxCommentPercentage = parseCommentPercentageLimit(normalized);
    return {
      id: ruleId("comment-quality", directive.text),
      type: "comment-quality",
      directive: directive.text,
      source: directive.source,
      mode: "warn",
      confirmed: true,
      enabled: true,
      filePatterns: DEFAULT_CODE_FILE_PATTERNS,
      bannedPatterns: DEFAULT_COMMENT_CONTEXT_PATTERNS,
      minAddedLinesForCommentPercentage:
        DEFAULT_MIN_ADDED_LINES_FOR_COMMENT_PERCENTAGE,
      ...(maxCommentLines === undefined ? {} : { maxCommentLines }),
      ...(maxCommentPercentage === undefined
        ? {}
        : { maxCommentPercentage }),
    };
  }

  return {
    id: ruleId("advisory", directive.text),
    type: "advisory",
    directive: directive.text,
    source: directive.source,
    mode: "warn",
    confirmed: true,
    enabled: true,
  };
}

export function compilePolicy(options: {
  directives: Directive[];
  sources: string[];
  agent: AgentName;
  acceptBlockingRules: boolean;
  now?: Date;
  fallbackToStarterPolicy?: boolean;
}): Policy {
  const now = (options.now ?? new Date()).toISOString();
  const usingStarterPolicy =
    options.directives.length === 0 &&
    (options.fallbackToStarterPolicy ?? true);
  const directives = usingStarterPolicy
    ? STARTER_DIRECTIVES
    : options.directives;
  const agents: AgentName[] = [...SUPPORTED_AGENT_NAMES];

  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    agents,
    sources:
      options.sources.length > 0
        ? options.sources
        : usingStarterPolicy
          ? ["starter policy"]
          : [],
    rules: directives.map((directive) =>
      classifyDirective(
        directive,
        options.acceptBlockingRules || usingStarterPolicy,
      ),
    ),
  };
}

export function confirmBlockingRules(
  policy: Policy,
  now = new Date(),
): Policy {
  if (
    !policy.rules.some((rule) => rule.mode === "block" && !rule.confirmed)
  ) {
    return policy;
  }
  return {
    ...policy,
    updatedAt: now.toISOString(),
    rules: policy.rules.map((rule) =>
      rule.mode === "block" && !rule.confirmed
        ? { ...rule, confirmed: true }
        : rule,
    ),
  };
}
