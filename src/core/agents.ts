export const SUPPORTED_AGENT_NAMES = [
  "claude",
  "cursor",
  "codex",
  "devin",
  "opencode",
  "polytoken",
] as const;

export type SupportedAgentName = (typeof SUPPORTED_AGENT_NAMES)[number];

export function isSupportedAgentName(
  value: string,
): value is SupportedAgentName {
  return SUPPORTED_AGENT_NAMES.includes(value as SupportedAgentName);
}

export function supportedAgentNames(): string {
  return SUPPORTED_AGENT_NAMES.join(", ");
}
