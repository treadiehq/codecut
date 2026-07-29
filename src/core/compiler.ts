import { createHash } from "node:crypto";
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
import type {
  AgentName,
  Directive,
  Policy,
  PolicyRule,
} from "./schema.js";

const STARTER_DIRECTIVES: Directive[] = [
  {
    text: "Do not skip project rules",
    source: {
      path: "starter policy",
      scope: "generated",
      conditional: false,
    },
  },
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
    text: "Keep prompts, agent instructions, tickets, and temporary files out of code comments",
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
    /(?:treat|consider)\s+warnings?.*(?:as\s+)?errors?|fail(?:ure)?\s+on\s+warnings?|\bno\s+warnings?\b/i.test(
      normalized,
    );
  const blockingRule = warningRule
    ? {
        type: "warnings-as-errors" as const,
        commandPatterns: DEFAULT_VERIFICATION_COMMAND_PATTERNS,
        warningPatterns: DEFAULT_WARNING_PATTERNS,
      }
    : /\b(?:all\s+)?(?:unit\s+)?tests?\s+(?:must\s+)?pass\b/.test(normalized)
      ? {
          type: "require-passing-tests" as const,
          commandPatterns: DEFAULT_TEST_COMMAND_PATTERNS,
          testOutputPatterns: DEFAULT_TEST_OUTPUT_PATTERNS,
        }
      : /\blocal(?:ly)?\b.*\btest|\btest.*\blocal(?:ly)?\b/.test(normalized)
        ? {
            type: "local-testing" as const,
            testCommandPatterns: DEFAULT_TEST_COMMAND_PATTERNS,
            remoteCommandPatterns: DEFAULT_REMOTE_COMMAND_PATTERNS,
            remoteToolPatterns: DEFAULT_REMOTE_TOOL_PATTERNS,
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
    /\bblast\s+radius\b|\bhigh[\s-]+confidence\b|\bchanges?\b.*\b(?:small|focused)\b/.test(
      normalized,
    )
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

  if (/\bverify\b|\bdon't assume\b|\bdo not assume\b/.test(normalized)) {
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

  if (/\bcomments?\b/.test(normalized)) {
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
    };
  }

  if (
    /\b(?:don't|do not|never)\s+skip\b.*\b(?:directives?|project\s+rules?)\b/.test(
      normalized,
    )
  ) {
    return {
      id: ruleId("meta-compliance", directive.text),
      type: "meta-compliance",
      directive: directive.text,
      source: directive.source,
      mode: "warn",
      confirmed: true,
      enabled: true,
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
}): Policy {
  const now = (options.now ?? new Date()).toISOString();
  const usingStarterPolicy = options.directives.length === 0;
  const directives = usingStarterPolicy
    ? STARTER_DIRECTIVES
    : options.directives;
  const agents: AgentName[] = ["claude", "cursor", "codex"];

  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    agents,
    sources:
      options.sources.length > 0
        ? options.sources
        : ["starter policy"],
    rules: directives.map((directive) =>
      classifyDirective(
        directive,
        options.acceptBlockingRules || usingStarterPolicy,
      ),
    ),
  };
}
