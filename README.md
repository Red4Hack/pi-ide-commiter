# pi IDE Commiter

A VS Code extension that writes your commit message using the [pi](https://pi.dev)
agent running **in the background over RPC**, with a button in the **Source Control**
panel.

Inspired by [`elt7613/pi-git-assistant`](https://github.com/elt7613/pi-git-assistant),
but cut down to the essential: it **only generates the commit message**. No branch
decision, no PR description — the extension never writes to your repository.

## How it works

```
VS Code                          background pi process
┌──────────────────┐             ┌─────────────────────────┐
│ SCM button       │             │  pi --mode rpc          │
│        ↓         │  JSONL      │  --no-tools             │
│ gather git       │ ──stdin───► │  --no-context-files     │
│ context (budgeted)│            │  --system-prompt <short>│
│        ↑         │ ◄─stdout──  │                         │
│ commit input box │  events     │  (stays alive between   │
└──────────────────┘             │   commits)              │
                                 └─────────────────────────┘
```

The `pi` process starts once and **stays alive**, so from the second commit on you
do not pay the cold start. Every generation begins with `new_session`, so one
generation never sees the previous diff.

## Minimal context

The point of pi.dev is sending little context. That is taken seriously on two fronts.

**In the pi process** — every flag removes tokens that would enter the prompt
without helping write a commit message:

| Flag | What it cuts |
|---|---|
| `--no-tools` | every tool definition |
| `--no-context-files` | `AGENTS.md` / `CLAUDE.md` |
| `--no-extensions` | extensions (pi-lens and friends) |
| `--no-skills`, `--no-prompt-templates` | skills and templates |
| `--system-prompt` | replaces the default coding-assistant prompt with ~700 chars |
| `--no-session` + `new_session` | zero accumulated history |
| `--thinking off` | a commit message does not need long reasoning |

**In the git context** — a budget instead of dumping the diff:

- per-file and total budgets, **derived automatically from the model's context
  window** (see [Automatic budget](#automatic-budget));
- when the budget is exceeded, it degrades to the `--stat` summary instead of
  cutting blindly;
- lockfiles (`package-lock.json`, `Cargo.lock`, `go.sum`, …) are listed **by name**,
  never by diff;
- a file cap, with the overflow covered by `--stat`;
- recent commit subjects ride along so the model matches the repository's style.

Measured on a realistic commit with a lockfile in the mix:

```
raw repository diff : 60,708 chars
total sent to pi    :  1,794 chars  (~449 tokens)
```

## Model

By default the extension **picks no model**: it uses whatever you already
configured in pi itself. To pin a model just for commits, run **pi IDE Commiter:
Select commit model** — from the Command Palette, or from the `...` overflow menu
next to the generate button in Source Control.

The picker reads pi's catalog over RPC (`get_available_models`), so it lists
exactly what is configured — with provider, context window and cost per Mtok —
instead of making you recall an id. The first entry is *Automatic*, which clears
the override and hands control back to pi.

## Automatic budget

Fixed numbers are wrong in both directions: too tight and a normal commit gets
truncated, so the message turns imprecise; too wide and small models blow up. With
`maxFiles`, `maxFileDiffBytes` and `maxTotalDiffBytes` at `0` (the default), the
budget comes from the context window of the model pi actually picked — 15% of the
window reserved for the diff, floored at 16,000 and capped at 120,000 chars:

| Model window | Total | Per file | Files |
|---|---|---|---|
| 32K | 17,203 | 4,000 | 20 |
| 128K | 67,200 | 11,200 | 21 |
| 200K | 105,000 | 17,500 | 33 |
| 262K | 120,000 | 20,000 | 44 |
| 1M | 120,000 | 20,000 | 80 |

Any field set to `> 0` beats the automatic value, and the decision is field by
field — you can pin just the total and leave the rest derived.

## Usage

Click the pi icon at the top of the **Source Control** panel. The message lands
straight in the commit box — you review it and commit.

If anything is staged, only the staged set is analysed. If nothing is staged, the
whole working tree is analysed, including new files.

### Where the commands live

Only *Generate commit message* is a visible button. The rest sit in the **`...`
overflow menu** in the Source Control title bar, right next to that button:

```
Source Control  ⟨search⟩            [π] [✓] [↻] [...]  ← click here
                                                  │
                                                  ├ pi IDE Commiter: Select commit model
                                                  └ pi IDE Commiter: Edit commit instructions
```

All five commands are also in the Command Palette (`Ctrl+Shift+P`) — type `pi IDE`.

That overflow menu shows only a command's title, never its category, which is why
every title here starts with `pi IDE Commiter:` rather than a bare `Select model`
that could belong to any extension.

## Custom prompt

Two settings shape what the model is told, both resolved per folder — so
`.vscode/settings.json` can give one repository its own house style.

**`customInstructions`** is appended to the built-in prompt and declared as taking
precedence, so it can actually override a built-in rule instead of quietly
conflicting with it:

```jsonc
{
  "pi-ide-commiter.customInstructions":
    "Always prefix the subject with the Jira ticket taken from the branch name, like ABC-123: add retry.\nNever use the 'chore' type; use 'build' or 'ci' instead."
}
```

**`systemPrompt`** replaces the built-in rules entirely — `style`, `includeBody`
and `maxSubjectLength` stop applying, and your prompt has to tell the model to
reply with the commit message only. `customInstructions` is still appended on top.

Editing either respawns the background pi process, because the prompt is passed as
`--system-prompt` at spawn time and a warm process would keep serving the old one.

Shortcut to the setting: **pi IDE Commiter: Edit commit instructions**.

## Installation

Requires `pi` installed with an authenticated provider (`pi auth check --provider <name>`).

**From the packaged `.vsix`:**

```bash
code --install-extension pi-ide-commiter-0.5.0.vsix
```

Or through the UI: Extensions panel → `...` → *Install from VSIX...*

**From source:**

```bash
npm install
npm run compile   # F5 in VS Code opens a window with the extension loaded
npm run package   # builds the .vsix
```

### Where pi is looked up

VS Code launched from a GUI launcher (system menu, dock) **does not inherit the
shell PATH** — that is why a `pi` installed via bun/nvm/npm-global works in the
terminal but not in the extension. Detection is automatic and tries, in order:

1. the inherited PATH (works when VS Code was launched from a terminal);
2. the user's login shell (`$SHELL -lic 'command -v pi'`, then `-lc`) — this is
   the step that covers the GUI launcher case;
3. the known install directories (`~/.bun/bin`, `~/.local/bin`, `~/.npm-global/bin`,
   `~/.volta/bin`, `/opt/homebrew/bin`, `%APPDATA%\npm`, …).

Every candidate is confirmed with `pi --version` before being accepted, so some
unrelated file named `pi` on the PATH will not pass. `pi-ide-commiter.piPath` still
exists to force a path — and when the forced path is wrong, the error points at the
setting instead of sending you hunting.

## Settings

| Key | Default | Description |
|---|---|---|
| `pi-ide-commiter.piPath` | *(empty)* | Path to pi; empty = automatic detection |
| `pi-ide-commiter.provider` | *(empty)* | `--provider`; prefer the model picker |
| `pi-ide-commiter.model` | *(empty)* | `--model`; prefer the model picker |
| `pi-ide-commiter.thinking` | `off` | Thinking level |
| `pi-ide-commiter.style` | `conventional` | `conventional` or `plain` |
| `pi-ide-commiter.includeBody` | `false` | Allow a multi-line body |
| `pi-ide-commiter.maxSubjectLength` | `72` | Maximum subject length |
| `pi-ide-commiter.language` | `english` | Message language |
| `pi-ide-commiter.customInstructions` | *(empty)* | Extra instructions appended to the prompt |
| `pi-ide-commiter.systemPrompt` | *(empty)* | Full prompt override (advanced) |
| `pi-ide-commiter.maxFiles` | `0` | Max files with a diff; `0` = automatic |
| `pi-ide-commiter.maxFileDiffBytes` | `0` | Per-file budget; `0` = automatic |
| `pi-ide-commiter.maxTotalDiffBytes` | `0` | Total budget; `0` = automatic |
| `pi-ide-commiter.recentCommitCount` | `10` | Recent commits sent as style hints |
| `pi-ide-commiter.timeoutMs` | `90000` | Timeout for one generation |
| `pi-ide-commiter.warmOnStartup` | `true` | Start pi when the workspace opens |
| `pi-ide-commiter.idleShutdownMs` | `1800000` | Shut down idle pi (0 = never) |
| `pi-ide-commiter.replaceExistingMessage` | `false` | Overwrite the box without asking |

Every key resolves per folder, so multi-root workspaces can use a different model
per repository.

Commands: `Generate commit message`, `Select commit model`,
`Edit commit instructions`, `Restart background agent` (which also clears the
cached pi path) and `Open log` — all prefixed with `pi IDE Commiter:`.

## Protocol details that matter

Two behaviours of pi's RPC mode that this implementation handles explicitly:

1. **Framing.** The protocol uses LF as the *only* record delimiter. Node's
   `readline` also splits on `U+2028`/`U+2029`, which are valid inside JSON strings
   and do appear in real diffs — using `readline` would corrupt the stream. Parsing
   is done by hand.

2. **Provider errors.** A provider 401/403 does **not** come back as a command
   response: it arrives as a `message_end` with `stopReason: "error"` and an
   `errorMessage`. With auto-retry on (the default), the RPC stream hangs silently
   for minutes. The extension turns auto-retry off (`set_auto_retry`) and surfaces
   the provider error directly in the notification.

## Tests and CI

```bash
npm test            # 36 tests: framing, discovery, budget, prompt, manifest, git
npm run test:real   # handshake against the real pi binary (spends no credit)
```

`test/stub-pi.js` is a fake pi that speaks the real protocol (payload shapes
captured from an actual `pi --mode rpc`), so the tests cover the provider-error
path and the timeout without depending on the network or on credit.

The workflow in `.github/workflows/ci.yml` runs on push, PR and manually, in two
jobs — the build only starts if the check passes:

| Job | Steps |
|---|---|
| **check** | `npm ci` → type check (`tsc --noEmit`) → manifest valid → icon assets present → `npm test` |
| **build** | compile → `vsce package` → verify the `.vsix` contents → upload as an artifact |

The `.vsix` verification fails if the runtime or the icon go missing, or if
sources/tests/CI leak into the package.

## Icon

The button uses the pi.dev mark (a blocky `P` plus the `i` dot, from
[pi.dev/logo.svg](https://pi.dev/logo.svg)), in two monochrome variants using
VS Code's standard toolbar colours — `#424242` in light themes and `#C5C5C5` in
dark — so it sits well next to its neighbours in Source Control. The mark belongs
to the pi project.

## License

MIT — see `LICENSE`. The copyright holder is a placeholder; put your own name there
before publishing.
