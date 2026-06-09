# REFERENCE.md — Detailed conventions

Open this on demand when `AGENTS.md` is not enough.

## File layout

```text
SKILL.md              skill metadata + read-order
AGENTS.md             LLM contract (read first)
browser-test          runner entrypoint; `new` scaffolds testcases
docs/REFERENCE.md     this file
docs/USAGE.md         end-user prompt patterns
docs/CI.md            CI / pipeline integration
scripts/              runner + setup scripts
eval/golden/          self-test fixtures for `./browser-test eval`
coverage.map.example  starter feature inventory copied by setup.sh
coverage.map          feature inventory (tracked, project root)
quarantine.json       gate skip-list with expiry (tracked, project root)
tests/                project testcases (one .md per testcase)
env/env.yaml          project defaults (committed)
env/env.local.yaml    local overrides (gitignored)
data/*.yaml           test inputs (committed)
data/*.local.yaml     local overrides (gitignored)
state/*.json          saved auth (gitignored, secrets)
fixtures/             upload/download files (committed)
outputs/<TC-ID>/...   runner artifacts + history.jsonl (gitignored)
```

## Frontmatter

Required:

```yaml
---
id: TC-001
title: "One-line title"
module: home
session: 001_home           # MUST equal filename without .md (files are NNN_<module>.md)
env: env/env.yaml
state: null
data: null
techniques: [semantic_locator, wait_url]
expect:
  url: null                 # final URL glob, e.g. "**/dashboard"
  text: null                # final visible text, e.g. "Saved"
---
```

Known `techniques` values (advisory — validator only warns on unrecognized
ones; add your own if it maps to a real agent-browser capability):
`semantic_locator`, `css_locator`, `snapshot_ref`, `network_route`,
`state_load`, `wait_url`, `wait_text`, `wait_load`, `wait_fn`,
`eval_stdin`, `react_devtools`.

Optional (omit unless needed):

```yaml
log_level: minimal          # minimal | normal | verbose
viewport: "1280x720"
headless: true
timeout_ms: 30000           # per-step budget in ms (see "Long-running tests")
profile: null               # Chrome profile name or absolute path
session_name: null          # AGENT_BROWSER_SESSION_NAME for auto-persist
device: null                # e.g. "iPhone 14"
color_scheme: null          # "light" | "dark"
profiler: false
```

## Inputs — what goes where

Four input types, each answering a different question. `env` + `data` become
`$SHELL_VARS`; `state` and `fixtures` are referenced by name/path.

| Dir / file | Answers | Declared via | Tracked? |
|------------|---------|--------------|----------|
| `env/env.yaml` | project config (no secrets) | default, or `env:` | committed |
| `env/env.local.yaml` | secrets + machine-local overrides | (same env file, local) | gitignored |
| `data/<name>.yaml` | **what values** to type (per testcase) | `data:` frontmatter → `$keys` | committed |
| `data/<name>.local.yaml` | local overrides of that data | (paired with the data file) | gitignored |
| `state/<name>.json` | **who you are** (saved login: cookies + localStorage) | `state:` frontmatter | gitignored (secret) |
| `fixtures/<file>` | **which file** to upload / compare on download | path in a step command | committed |

Rules of thumb: config/credentials → `env/`; typed values → `data/`; "start
logged-in" → `state/`; files the flow reads or writes → `fixtures/`. A single
testcase can use all four. Example:

```yaml
state: state/admin.auth.json   # start authenticated as admin
data: data/checkout.yaml       # quantity, coupon → $quantity, $coupon
```
```bash
agent-browser --session "$SESSION" find label "Qty" fill "$quantity"
agent-browser --session "$SESSION" upload "input[type=file]" fixtures/invoice.pdf
```

`data/checkout.yaml`:

```yaml
quantity: 2
coupon: SAVE10
```

`env`/`data` precedence (low → high): ambient `process.env` < `env/env.yaml` <
`env/env.local.yaml` < `data/<name>.yaml` < `data/<name>.local.yaml` — a declared
test value always wins over a stray CI env var of the same name. The runner then
force-sets `SESSION`, `TC_ID`, `RUN_DIR`, `DOWNLOAD_DIR` (downloads land in
`DOWNLOAD_DIR`). Create a `state` file with `agent-browser state save
state/<name>.json` (see Auth strategies).

## Long-running / repeated-action tests

Each step runs in one `bash -c` with a per-step budget (default 30 s). Exceeding
it kills the step → fail, class `timing` ("step exceeded the per-step timeout…").
A 1000-reload loop in one step blows the budget. If a long run is intentional:

1. **Split the loop across steps** (bounded batches, e.g. 50) — gives progress,
   per-step artifacts, and tells you *which* batch failed. Preferred.
2. **Raise the budget** when the work truly belongs in one step:
   `timeout_ms: 1800000` (frontmatter, per testcase) or `-t 1800` (one-off).
3. **Keep soak tests off the PR gate** — own file/schedule, or `quarantine` them;
   otherwise they dominate wall-clock and flake budget.

Limits (by design): `timeout_ms`/`-t` bound both the whole step and each
`agent-browser` call (raising it relaxes the per-call guard — prefer splitting).
Step output is flushed at step end, not live (`echo` progress → read `run.log`).
`-j` parallelizes across testcases, not within a step.

## Auth strategies

Pick exactly one per testcase:

| Strategy         | How                                                   | When |
|------------------|-------------------------------------------------------|------|
| Fresh isolated   | `state: null`                                         | public pages, login flow itself |
| Saved auth state | `state: state/admin.auth.json`                        | CI/regression skipping login |
| Auto-persisted   | `session_name: local-admin`                           | local repeated debugging |
| Chrome profile   | `profile: Default` or absolute path                   | SSO / OAuth / manual login |
| Auth vault       | `agent-browser --session "$SESSION" auth login admin` | credentials live in vault |

`state/*.json` and `session_name` data files are secrets; gitignored. The
mechanics of creating/encrypting them (`state save`, the auth vault,
`AGENT_BROWSER_ENCRYPTION_KEY`) live in the core skill — `agent-browser skills get
core --full`. Papaya only declares *which* strategy a testcase uses, via the
frontmatter field above.

## Logging

Controlled by `log_level` (env > frontmatter > CLI; CLI wins via
`--log-level <lvl>` or `-v`):

| Level     | `run.log`             | `stepN-before/after/diff.txt` |
|-----------|-----------------------|-------------------------------|
| `minimal` | only when test fails  | only for the failed step      |
| `normal`  | always                | only for the failed step      |
| `verbose` | always                | every step                    |

Default `minimal`. Use `-v` while debugging.

## Runner output

Per run, under `outputs/<TC-ID>/<UTC-ms>/` (symlinked as `latest/`):

Always: `summary.md`, `result.json`, `console-errors.log`, `final.png`,
`final-annotated.png`.

Conditional: `run.log`, `stepN-before/after/diff.txt`, `profile.json`
(with `profiler: true` or `--profiler`).

**Debug order on failure**: `summary.md` → `stepN-diff.txt` →
`final-annotated.png` → `console-errors.log` → `run.log`.

## Step format (intent-first, self-healing)

Each step has two bullets — `intent` (the semantic goal, the source of truth)
and `expect` (the observable success signal) — followed by a `bash` block that
is a *cache* of the intent (commands you saw pass live).

````markdown
### 1. Open login
- intent: load the login page and confirm the form is shown
- expect: "Log in" visible and a password field present
```bash
agent-browser --session "$SESSION" open "$base_url/login"
agent-browser --session "$SESSION" wait --text "Log in"
agent-browser --session "$SESSION" is visible 'input[type=password]' \
  || { echo "FAIL: login form not rendered"; exit 1; }
```
````

Each step is small and ends with a real assertion or signal-based wait. The
validator warns (does not fail) if `intent` is missing, but without it the step
cannot self-heal.

## Exploration vs saved locators

The two-phase rule (see `AGENTS.md → Two phases`): `@eN` refs are king while
*exploring* live, but they're renumbered on every snapshot, so they can't be
frozen into a saved test. When you save a step, translate each ref into the most
durable locator that still works — app test attributes → role + name →
label/placeholder → exact text → scoped CSS — keeping `@eN` only for an action
immediately after a fresh snapshot in the same step, or a visual-only target with
no semantic handle. `./browser-test discover <url>` lists the durable handles on a
page. Use `eval --stdin` or base64 for complex JavaScript; inline `eval "..."` is
only for short expressions.

## Self-healing workflow

A failed run writes `outputs/<TC-ID>/latest/heal-brief.md` and a `summary.md`
that names the failure class:

| Class             | Meaning                                   | Action |
|-------------------|-------------------------------------------|--------|
| `selector_drift`  | element renamed/moved                     | `./browser-test heal <file> <step>`, re-resolve from intent, patch, rerun |
| `timing`          | element/state arrived late                | add `wait --text/--url/--load/--fn` |
| `assertion_drift` | flow ran, final expectation changed       | confirm with the director — real change or bug? |
| `auth_env`        | login expired / seed missing / 401·403    | stop, report blocked, never fabricate |
| `app_bug`         | 5xx / console exception                    | capture repro, surface as candidate bug |

`./browser-test heal <file> <step>` prints the step's intent paired with a live
`snapshot -i`. Re-resolve, patch the cached commands, then `validate` + `run`.
Always show the diff for review; healing never rewrites the `.md` for you.

## agent-browser commands

Papaya does **not** restate agent-browser's command surface — it drifts from the
installed CLI and duplicates a better, version-matched source. For any browser
command (snapshot, find, wait, get, upload, state, network, auth, iframe, dialog,
tabs, ...) read:

```bash
agent-browser skills get core --full      # full reference + patterns
agent-browser <command> --help            # one command
```

Every command in a saved step is prefixed with `agent-browser --session "$SESSION"`.

## Runner commands

```bash
./browser-test new <module> "<title>"  # scaffold a new testcase
./browser-test discover <url>          # list testable locators on a page
./browser-test validate <file|dir>     # static checks
./browser-test run      <file|dir>     # execute (folder = all .md inside)
./browser-test list                    # testcases + last status
./browser-test history [<TC-ID>]       # last 10 runs + flake (all or one TC)
./browser-test heal <file> <step>      # heal brief: intent + live snapshot
./browser-test flaky                   # flake scores + quarantine advice
./browser-test quarantine [list|add|remove <TC-ID>]   # manage the gate skip-list
./browser-test coverage                # features tested vs gaps
./browser-test eval                    # self-test the skill's machinery
./browser-test doctor                  # agent-browser doctor
```

## Coverage

`coverage.map` (tracked, repo root) is the feature inventory — the mandate that
makes "what the app does vs what is tested" visible. One feature per line:

```text
# module | Feature name | optional-route-glob
login    | Login flow    | **/login
checkout | Checkout      | **/checkout/**
```

A feature is **covered** only if it has a non-quarantined test whose **last run
passed** (protection, not file existence). A test that's failing, never-run, or
quarantined shows `⚠ partial` and doesn't count. `coverage` prints a table
(`✓`/`⚠`/`·`), the passing-%, gaps, and modules tested but absent from the map.
**Drift** (tested module not in the map) exits non-zero so CI keeps the map
honest; gaps don't. (`route` is reference-only; module is the join key.) No
`coverage.map` → lists `tests/` modules + how to start. Starter:
`coverage.map.example`.

## CI / pipeline mode

`./browser-test run <dir> --ci` quiets the step logs and prints a single JSON
summary line to stdout; `--junit <file>` additionally writes a JUnit XML report.
The exit code gates the pipeline (non-zero on any executed failure; quarantined
flows are `skipped`, never fail). `./browser-test doctor` is a preflight that
checks node, agent-browser, `env/env.yaml`, `tests/`, `quarantine.json`, and
`coverage.map`, then chains `agent-browser doctor` — safe to gate a CI job on.
Full recipes (GitHub Actions, auth in CI, the skill self-test job) are in
[`CI.md`](./CI.md).

## Eval — the skill proves itself

`./browser-test eval` is the skill's own regression suite (not an LLM
benchmark). It runs `eval/golden/`: the `good/` case must validate clean,
and each `bad/` case must trip exactly the rule it targets (declared in
`eval/golden/manifest.json`). It also checks the failure classifier and the
flake math against fixtures. A non-zero exit means a regression in the skill
itself — wire it into CI for the skill repo. Run it after editing the validator,
classifier, or flake logic.

## Flake intelligence

Every run appends a record to `outputs/history.jsonl` (local telemetry,
gitignored): timestamp, status, duration, and the failure class. `history` and
`flaky` read this log.

**Flake score** = over the last 20 runs, how often the flow *flips* pass↔fail
(stable ≈ 0; oscillating high). Consistently failing = broken, not flaky (needs
both passes and fails). Threshold `>= 0.34`, with three guards:

- **Min sample**: < 5 runs is never flaky (else one pass+fail scores 1.0).
- **Intermittent ≠ flaky**: oscillation whose failures are `app_bug`,
  `assertion_drift`, `env_error`, or `unknown` is `[INTERMITTENT]`, not `[FLAKY]`,
  and is **not** recommended for quarantine (likely a real defect). Only
  `timing`/`selector_drift` oscillation is quarantine-eligible.
- **Commit scoping**: with a git commit in history, the window narrows to the
  current commit so pre-fix failures don't taint a just-fixed test.

**Quarantine** (`quarantine.json`, tracked → PR-visible) skips a flow in batch
`run <dir>` but not in single-file `run` (so you can heal it). Each entry has a
reason, date, commit, and **expiry** — on expiry it auto-returns to the gate
(default 14 days; `--days 0` = no expiry, warned).

```bash
./browser-test flaky                                   # scores + suggestions
./browser-test quarantine add TC-007 --reason "login race" --days 7
./browser-test quarantine list                          # shows expiry + [EXPIRED] tags
./browser-test quarantine remove TC-007                 # heal then release
./browser-test run tests/ --include-quarantined         # force-run everything
```

If a batch executes **nothing** because every flow is quarantined, the gate
**fails** (exit ≠ 0) rather than reporting a false green over zero coverage.

Telemetry never breaks a run: if the log can't be written, the run still records
its normal artifacts.

Full `run` flags via `./browser-test run --help` (`-s -e -t -v --log-level
--no-teardown --no-diff --profiler --report --ci --junit -j --include-quarantined`).

## Common mistakes (anti-patterns)

| ❌ | ✅ |
|---|---|
| `wait 3000` with no `# reason` | `wait --text/--url/--load/--fn` or `wait @ref` |
| `grep -q .` / `grep -q ""` | `wait --text "<expected>"` or grep a real substring |
| Hard-coded URL like `https://staging.my.host` | `$base_url` / shell var from env |
| `password: hunter2` in frontmatter | `env/env.local.yaml` or `agent-browser auth` |
| `agent-browser open "$base_url"` (no `--session`) | always include `--session "$SESSION"` |
| Writing steps before live exploration | explore first, copy what passed |
| Inventing `agent-browser` flags | `agent-browser <cmd> --help` first |
| Reporting done after writing only | done = `validate` AND `run` both pass |
| `set +e` / `\|\| true` / `trap … ERR` (false green) | fail loudly: `\|\| { echo "FAIL"; exit 1; }` |
| `get url` with output unchecked | pipe to `grep`, or `wait --text/--url` |
| `expect.url: "**"` / `""` (tautology) | a real glob `**/path`, or `url: null` |
| Reusing a TC-ID across files | every testcase has a unique `TC-NNN` |
| `eval 'var els=document.querySelectorAll("input"); els[0].value=…'` | `find first '[data-qa="field-name"]' fill "$value"` — positional indexing breaks silently when the DOM changes |
| Full signup/login flow as Step 1 of a non-auth test | save auth once (`state save state/user.auth.json`), then `state: state/user.auth.json` in frontmatter |
| Repeating `network route … --abort` in every step | routes persist for the session; set them once after the first `open` |
| Hard-coded test data (`"4111111111111111"`, `"hunter2"`) in bash | move to `data/<name>.yaml`, declare `data:` in frontmatter, reference as `$card_number` |

## Cross-platform notes

- **Linux ARM64**: Chrome for Testing has no ARM64 build. Install Chromium
  via package manager and set `AGENT_BROWSER_EXECUTABLE_PATH`. See
  `scripts/setup.sh` which detects and suggests this.
- **Cloud browsers**: agent-browser supports `-p browserless`,
  `-p browserbase`, `-p kernel`, `-p agentcore` when local Chrome is
  unavailable.
- **Windows**: bash steps require WSL.

## Reference

- https://agent-browser.dev/ — overview, install, snapshot/ref model
- https://agent-browser.dev/skills — skills system
- https://github.com/vercel-labs/agent-browser — source repo
- `agent-browser skills get core --full` — full in-CLI command reference
- `agent-browser doctor` — diagnose install / daemon / Chrome
