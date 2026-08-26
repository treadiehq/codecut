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

## Get started

For Claude Code, run:

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

To keep Codecut setup inside the current project, pass `--agent` without
`--user`:

```sh
codecut setup --agent claude
codecut setup --agent cursor
codecut setup --agent codex
codecut setup --agent devin
codecut setup --agent opencode
codecut setup --agent polytoken
```

Project setup adds the agent hook, checks that it works, and creates
`.codecut/policy.json`.

Codex loads project hooks after you trust the project in Codex.

## Change the rules

Edit the instruction files you already use, such as `AGENTS.md`, `CLAUDE.md`,
`.cursor/rules`, or `.devin/rules`. Then refresh Codecut:

```sh
codecut setup --agent cursor --refresh-policy --accept
```

You can also edit `.codecut/policy.json` directly.

For example, add this to an instruction file to set a stricter comment budget:

```md
- Keep comment lines below 15% of added source lines
```

Codecut checks comment density after at least 20 non-blank source lines have
been added, which avoids noisy warnings on small edits. Density warnings tell
the agent to remove comments that narrate history or process or restate code,
while preserving comments about lasting constraints.

For strict comment hygiene, combine the density budget with a one-line comment
limit and the pre-push gate:

```md
- Keep comment lines below 15% of added source lines
- Do not add code comments longer than one line
- Require clean Codecut lint for git push
```

The first two rules define the measurable comment budget. The third makes
violations block supported `git push` commands instead of relying on another
instruction for the agent to remember.

### Require clean lint before push

To stop an agent from pushing deterministic Codecut findings, add this explicit
opt-in rule:

```md
- Require clean Codecut lint for git push
```

Refresh the policy with `--accept` to activate the blocking rule. Before a
supported `git push`, Codecut compares `HEAD` with the local remote-tracking
branch and runs the configured comment-quality, TODO, debug-artifact, and
blast-radius checks. Findings block the command and include a copy-pasteable
`codecut lint --range <base>..<head>` recovery command.

Simple current-branch pushes are supported, including `git push`,
`git push -u origin HEAD`, and explicit current-branch refspecs. Multi-branch
pushes and missing or stale local tracking information produce a warning
instead of pretending the outgoing diff was verified. Run `git fetch` before
pushing when the remote branch may have changed.

### Require a ready GitHub PR

Cursor Automations create draft PRs by default. To require the agent to finish
with a reviewable PR, add this explicit opt-in rule:

```md
- Open a non-draft PR
```

Then refresh and accept the blocking rule:

```sh
codecut setup --agent cursor --refresh-policy --accept
```

At the stop hook, Codecut uses `git` and the authenticated GitHub CLI to verify
that the current branch has an open, non-draft PR at the current commit. A
draft tells the agent to run `gh pr ready`; a missing PR tells it to run
`gh pr create --fill`; and a stale PR must be pushed. Install `gh` and run
`gh auth login` first. If GitHub state cannot be verified because the CLI,
authentication, or network is unavailable, Codecut warns instead of claiming
the PR failed the rule.

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
policy engine is agent-neutral; Claude Code, Cursor, Codex, Devin, OpenCode,
and Polytoken currently have native hook installers. Restart OpenCode after
setup so it loads the generated plugin.

### T3 Code

T3 Code is a control surface over other coding agents, so configure Codecut for
the provider T3 Code launches:

```sh
codecut setup --agent claude
codecut setup --agent codex
codecut setup --agent opencode
```

There is no separate `--agent t3code` mode. For a remote OpenCode server, install
the user-level OpenCode plugin on the server machine; project plugins work when
the T3 Code provider runs OpenCode against the local project.

### Custom agents

Private and unsupported agents can use Codecut through the versioned generic
hook protocol. No Codecut-specific SDK or native installer is required: send
one JSON event on stdin and read one JSON decision from stdout.

```sh
printf '%s' '{
  "protocol": "codecut.agent-hook",
  "version": 1,
  "event": "pre-tool",
  "session_id": "session-123",
  "cwd": "/workspace/project",
  "agent_name": "company-agent",
  "tool": {
    "name": "shell",
    "call_id": "call-456",
    "input": { "command": "git push" }
  }
}' | codecut hook --agent generic
```

The response always uses the same envelope:

```json
{
  "protocol": "codecut.agent-hook",
  "version": 1,
  "action": "deny",
  "outcome": "block",
  "summary": "1 rule checked · 1 issue",
  "message": "Codecut found 1 issue...",
  "violations": [
    {
      "directive": "Require clean Codecut lint for git push",
      "severity": "block",
      "evidence": "1 Codecut lint finding remains...",
      "recovery": "Run codecut lint, fix every finding, then retry git push."
    }
  ]
}
```

Call the protocol at `pre-tool`, `post-tool`, `post-tool-failure`, `stop`,
`agent-response`, and `context-reset` lifecycle boundaries. Keep
`session_id` stable and reuse `tool.call_id` before and after a tool call. The
`outcome` reports the policy result; the `action` tells the host what to do:
pre-tool events return `allow` or `deny`, post-tool events return
`acknowledge`, and stop events return `continue` or `stop`. A custom agent must
expose these lifecycle boundaries and honor `action` for enforcement to work.

`generic` is a hook-only integration. Native setup and hook installation
commands intentionally do not accept `--agent generic`; custom agents invoke
the protocol command directly.

Print the authoritative input and output JSON Schemas with:

```sh
codecut hook --agent generic --schema
```

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
codecut lint --range origin/main..HEAD # an exact Git revision range
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
