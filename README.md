# Codecut

Keep your coding agents on track.

Codecut turns project rules into automatic checks. When an agent breaks a rule,
Codecut explains what happened and how to fix it.

## What it catches

- Missing or failing tests
- Tests run on remote machines
- Warnings in test, lint, typecheck, or build output
- Temporary agent context left in code comments
- Large changes that need an explanation

Codecut only blocks behavior it can check reliably. Everything else stays
visible as advice.

## Install

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/treadiehq/codecut/main/scripts/install.sh | bash
```

Windows PowerShell:

```sh
irm https://raw.githubusercontent.com/treadiehq/codecut/main/scripts/install.ps1 | iex
```

## Get started

Run one of these commands inside your project:

```sh
# Cursor
codecut setup --agent cursor

# Claude Code
codecut setup --agent claude

# Codex
codecut setup --agent codex
```

That is it. Codecut adds the agent hook, checks that it works, and creates
`.codecut/policy.json`.

Codex loads project hooks after you trust the project in Codex.

## Change the rules

Edit the instruction files you already use, such as `AGENTS.md`, `CLAUDE.md`,
or `.cursor/rules`. Then refresh Codecut:

```sh
codecut setup --agent cursor --refresh-policy --accept
```

You can also edit `.codecut/policy.json` directly.

Real-time enforcement requires lifecycle hooks from the coding agent. Codecut's
policy engine is agent-neutral; Claude Code, Cursor, and Codex currently have
native hook installers.

```sh
codecut status  # Show active rules and hook health
codecut test    # Check that the rules work
codecut update  # Install the latest release and refresh project hooks
```

## Development

```sh
pnpm install
pnpm check
pnpm build:binary
```

## License

[FSL-1.1-MIT](LICENSE)
