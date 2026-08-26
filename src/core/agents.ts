export const SUPPORTED_AGENT_NAMES = [
  "claude",
  "cursor",
  "codex",
  "devin",
  "opencode",
  "polytoken",
] as const;

export type SupportedAgentName = (typeof SUPPORTED_AGENT_NAMES)[number];
export const HOOK_AGENT_NAMES = [...SUPPORTED_AGENT_NAMES, "generic"] as const;
export type HookAgentName = (typeof HOOK_AGENT_NAMES)[number];

export function isSupportedAgentName(
  value: string,
): value is SupportedAgentName {
  return SUPPORTED_AGENT_NAMES.includes(value as SupportedAgentName);
}

export function supportedAgentNames(): string {
  return SUPPORTED_AGENT_NAMES.join(", ");
}

export function isHookAgentName(value: string): value is HookAgentName {
  return HOOK_AGENT_NAMES.includes(value as HookAgentName);
}

export function hookAgentNames(): string {
  return HOOK_AGENT_NAMES.join(", ");
}
