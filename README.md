# Papaya — Browser Skill for LLM Agents

A copy-into-project skill that teaches an LLM agent to **drive a real browser
reliably** on top of [`agent-browser`](https://agent-browser.dev/) — and to save
the verified flow as a re-runnable Markdown file.

The agent is the actor: it explores live, copies only what passed, and saves
the result. Re-running that Markdown flow later **is** the regression — so the
most common use is browser integration testing, though underneath it's just
reliable, repeatable browser control.

The `browser-test` CLI below is a tool the agent reaches for, not the point —
the point is the agent and the flows it writes.

**Humans read this file. LLM agents read [`AGENTS.md`](./AGENTS.md) first.**

## Files at a glance

| File | Audience | Purpose |
|------|----------|---------|
| `SKILL.md`       | skill loader  | metadata (name, version, triggers, requires) |
| `AGENTS.md`      | LLM           | concise contract — read before any work |
| `browser-test`   | runner CLI    | entrypoint; `new` scaffolds a testcase with the right id/session/shape |
| `docs/`          | on-demand     | `REFERENCE.md` (full detail), `USAGE.md` (prompt patterns), `CI.md` |
| `eval/`          | maintainer    | golden fixtures for `./browser-test eval` |
| `scripts/`       | runner internals | runner mjs + setup |
| `tests/`         | project       | one `.md` testcase per file |
| `env/`           | project       | defaults (committed) + local overrides (gitignored) |
| `data/`          | project       | test inputs (committed) + local overrides |
| `state/`         | project       | saved auth state (gitignored, secrets) |
| `fixtures/`      | project       | upload/download files |
| `coverage.map.example` | project | starter feature inventory; copy to `coverage.map` |
| `outputs/`       | runtime       | run artifacts (gitignored) |

## Using with coding agents

You don't need per-IDE rule files. Two IDE-agnostic mechanisms do the work:

1. **The CLI teaches the agent as it acts** — the `new` scaffold comment,
   validator errors (rule + fix), `heal-brief.md`, and `summary.md` are read
   straight from the terminal the agent is driving, in any IDE.
2. **The gate guarantees correctness** — a guessed or un-run testcase fails
   `./browser-test run` or shows `UNVERIFIED` under `./browser-test list
   --strict`. Run it in CI; don't trust the agent's word.

The contract is [`AGENTS.md`](./AGENTS.md) (the cross-tool `AGENTS.md` standard,
read natively by Claude Code / Codex). Optional: to nudge first-try compliance,
point your agent's own rules file at it with one line (e.g. Cursor `.cursor/rules`,
Cline `.clinerules`, Copilot `.github/copilot-instructions.md`): "Follow `AGENTS.md`."

## Install into a project

```bash
# Copy the skill into your project. Skips Papaya's repo meta (your .gitignore /
# README / package.json / LICENSE stay yours) and its demo/instance files, so
# your tests, env, and coverage map aren't overwritten. setup.sh then scaffolds
# env.yaml and coverage.map from the shipped .example files.
rsync -a \
  --exclude '.git' --exclude '.gitignore' --exclude 'README.md' \
  --exclude 'package.json' --exclude 'LICENSE' \
  --exclude 'tests' --exclude 'data' --exclude 'state' \
  --exclude 'outputs' --exclude 'fixtures' \
  --exclude 'env/env.yaml' --exclude 'env/env.local.yaml' --exclude 'coverage.map' \
  path/to/papaya/ <your-project>/
cd <your-project>
bash scripts/setup.sh                     # scaffold env/coverage from examples, check requirements
$EDITOR env/env.yaml                      # set project base_url etc.
$EDITOR env/env.local.yaml                # set local secrets if any
```

`setup.sh` does local checks and scaffolds only — never `sudo`, never
global installs. It also merges Papaya's required ignore entries into your
project `.gitignore` once (idempotent).

## Daily use

```bash
./browser-test new      <module> "<title>" # scaffold a new testcase
./browser-test discover <url>              # list testable locators on a page (data-qa, roles)
./browser-test list                        # what testcases exist + last status
./browser-test validate tests/<file>.md    # static lint
./browser-test run      tests/<file>.md    # execute (one file)
./browser-test run      tests/             # execute (all .md under folder)
./browser-test history [<TC-ID>]           # last runs + flake %
./browser-test heal     tests/<file>.md N  # heal brief for step N (intent + live snapshot)
./browser-test flaky                       # flake scores + quarantine advice
./browser-test coverage                    # features tested vs gaps
./browser-test eval                        # self-test the skill's machinery
./browser-test doctor                      # agent-browser doctor
```

On failure read `outputs/<TC-ID>/latest/summary.md` first — it names the failure
class and the next action. For selector drift, `./browser-test heal <file> <step>`
prints the step's intent next to a live snapshot so you can re-resolve it.

## References

- [agent-browser.dev](https://agent-browser.dev/) — overview, install
- [agent-browser.dev/skills](https://agent-browser.dev/skills) — skills system
- [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) — source
- `agent-browser skills get core --full` — version-matched in-CLI reference
- `agent-browser doctor` — diagnose install / daemon / Chrome
