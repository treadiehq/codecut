# Codecut

Keep your coding agents on track.

Codecut turns project rules into automatic checks. When an agent breaks a rule,
Codecut explains what happened and how to fix it.

## What it catches

- Missing or failing tests
- Tests run on remote machines
- Warnings in test, lint, typecheck, or build output
- Temporary agent context left in code comments
- Code comments longer than a limit you set ("no comments longer than one line")
- Comment-heavy changes above a percentage you set ("keep comment lines below 25% of added source lines")
- `git push` commands whose outgoing branch diff has Codecut lint findings
- Draft or missing GitHub PRs when you require a ready-for-review handoff
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

## Quick start

Set up Claude Code for every repository:

```sh
codecut setup
```

This is equivalent to `codecut setup --user --agent claude`. It installs a
user-level hook that works in every repository and starts with a safe warning
for temporary agent context left in code comments.

For a different agent, select it explicitly:

```sh
codecut setup --user --agent cursor
codecut setup --user --agent codex
codecut setup --user --agent devin
codecut setup --user --agent opencode
codecut setup --user --agent polytoken
```

Remove `--user` to configure only the current project:

```sh
codecut setup --agent claude
codecut setup --agent cursor
```

Check that everything works:

```sh
codecut status
codecut test
```

## Add rules

Write rules in `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, or `.devin/rules`:

```md
- All unit tests must pass
- Keep comment lines below 15% of added source lines
- Require clean Codecut lint for git push
- Open a non-draft PR
```

Refresh the policy:

```sh
codecut setup --agent cursor --refresh-policy --accept
```

`--accept` activates rules that can block work. Without it, new blocking rules
stay advisory.

Personal rules that should work in every repository live in
`~/.config/codecut/AGENTS.md`. Refresh them with:

```sh
codecut setup --user --agent cursor --refresh-policy --accept
```

## What Codecut checks

- Tests pass and run locally
- Test, lint, typecheck, and build output has no warnings
- Comments avoid temporary agent context and excessive density
- Outgoing changes pass Codecut lint before `git push`
- Required GitHub pull requests are open and ready for review
- Large changes include an explanation

Codecut only blocks behavior it can verify. Everything else remains advice.

## Supported agents

Claude Code, Cursor, Codex, Devin, OpenCode, and Polytoken have native setup.
For T3 Code, configure the Claude, Codex, or OpenCode provider it launches.

### Custom agents

Private and unsupported agents can use the versioned JSON hook protocol:

```sh
codecut hook --agent generic --schema
```

Send one JSON event on stdin and read one JSON decision from stdout. Custom
agents must honor the returned `action`.

## Lint without hooks

Try Codecut on any repository or pull request:

```sh
codecut lint
codecut lint --staged
codecut lint --base origin/main
codecut lint --pr 123
```

## Useful commands

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
