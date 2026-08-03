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

# Polytoken
codecut setup --agent polytoken
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

## User-level rules

Rules that should apply in every project on your machine live in
`~/.config/codecut/AGENTS.md` (Codecut honors `XDG_CONFIG_HOME`). Compile
them once and every project's hooks pick them up:

```sh
codecut setup --user
```

User rules merge with each project's policy when hooks run; project rules
win on overlap, and user rules are never written into a project's
`.codecut/policy.json`. After editing the file, recompile with
`codecut setup --user --refresh-policy` (add `--accept` to activate rules
that can block work).

To skip per-project setup entirely, add an agent and Codecut installs
user-level hooks (for example `~/.cursor/hooks.json`):

```sh
codecut setup --user --agent cursor
```

User-level hooks enforce your user rules in every repository, even ones
that never ran `codecut setup`, and store session state under
`~/.local/state/codecut/` instead of the repository. In projects that have
their own Codecut hooks, the user-level hook stands down so nothing runs
twice. User-level hooks run the `codecut` binary from your PATH.

Real-time enforcement requires lifecycle hooks from the coding agent. Codecut's
policy engine is agent-neutral; Claude Code, Cursor, Codex, and Polytoken
currently have native hook installers.

```sh
codecut status  # Show active rules and hook health
codecut test    # Check that the rules work
codecut update  # Install the latest release and refresh project hooks
```

## Lint a diff or pull request

`codecut lint` runs only the heuristic, diff-based checks. It needs no hooks,
no setup, and no policy file, so you can try it on any repository or pull
request and judge the feedback for yourself:

```sh
codecut lint                       # uncommitted changes
codecut lint --staged              # staged changes
codecut lint --base origin/main    # a pull request branch
codecut lint --pr 123              # a GitHub pull request (requires gh)
git diff main...HEAD | codecut lint --patch -
```

When a `.codecut/policy.json` exists, `codecut lint` reuses its comment
patterns and blast-radius limits so lint results match hook enforcement.

## Development

```sh
pnpm install
pnpm check
pnpm build:binary
```

## License

[FSL-1.1-MIT](LICENSE)
