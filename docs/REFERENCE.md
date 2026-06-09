# REFERENCE.md - Papaya details

Open this only when `AGENTS.md` is not enough. Papaya owns testcase structure,
validation, execution, artifacts, CI status, flake, and coverage. `agent-browser`
owns browser command syntax. For browser commands use:

```bash
agent-browser skills get core --full
agent-browser <command> --help
```

## Files

```text
SKILL.md                    skill metadata
AGENTS.md                   LLM contract
browser-test                CLI entrypoint
scripts/                    runner and setup
docs/                       reference, usage, CI notes
eval/golden/                validator regression fixtures
tests/<NNN>_<module>.md     testcases
env/env.yaml                project config, committed
env/env.local.yaml          local secrets/overrides, gitignored
data/<name>.yaml            testcase input data, committed
data/<name>.local.yaml      local data overrides, gitignored
state/<name>.json           auth state, gitignored secret
fixtures/                   upload/download fixtures
outputs/<TC-ID>/...         run artifacts, gitignored
coverage.map                tracked feature inventory
quarantine.json             tracked skip-list with expiry
```

## Frontmatter

Required:

```yaml
---
id: TC-001
title: "One-line title"
module: home
session: 001_home
env: env/env.yaml
state: null
data: null
techniques: [semantic_locator, wait_text]
expect:
  url: null
  text: null
---
```

Rules:

- Filename is `NNN_<module>.md`; `id` is `TC-NNN`; `session` equals filename
  without `.md`.
- `expect.url` is a useful route glob or `null`; not `**` or `""`.
- `techniques` is advisory. Unknown values warn, not fail.
- The parser is intentionally small: scalars, inline arrays, and one nested
  mapping level for `expect`. Avoid multiline YAML, anchors, and deep nesting.

Optional fields:

```yaml
log_level: minimal
viewport: "1280x720"
headless: true
timeout_ms: 30000
profile: null
session_name: null
device: null
color_scheme: null
profiler: false
```

## Inputs

| Input | Purpose | Tracked |
|-------|---------|---------|
| `env/env.yaml` | project config, no secrets | yes |
| `env/env.local.yaml` | local secrets/overrides | no |
| `data/<name>.yaml` | values typed by a testcase | yes |
| `data/<name>.local.yaml` | local data overrides | no |
| `state/<name>.json` | saved auth state | no |
| `fixtures/<file>` | files used by upload/download flows | yes |

Precedence: ambient env < `env` < `env.local` < `data` < `data.local`.
The runner also sets `SESSION`, `TC_ID`, `RUN_DIR`, and `DOWNLOAD_DIR`.

## Step Format

Each step has intent, expectation, and one bash block:

````markdown
### 1. Open login
- intent: load the login page and confirm the form is ready
- expect: "Log in" visible and a password field present
```bash
agent-browser --session "$SESSION" open "$base_url/login"
agent-browser --session "$SESSION" wait --text "Log in"
agent-browser --session "$SESSION" is visible 'input[type=password]' \
  || { echo "FAIL: login form not rendered"; exit 1; }
```
````

The bash block is a proven cache of the intent. Keep steps small. End each step
with a real signal (`wait`, `find`, `is`, or checked `get`).

## Locator Policy

Explore with agent-browser refs as described by the core guide. Save durable
locators:

1. app test attributes,
2. semantic locator by role/name, label, placeholder, or exact text,
3. scoped CSS,
4. `eval --stdin` only as a last resort.

`./browser-test discover <url>` helps list durable handles.

## Auth

Declare the strategy; let agent-browser own the mechanics:

| Case | Frontmatter |
|------|-------------|
| login/signup is the test | `state: null` |
| normal authenticated flow | `state: state/user.auth.json` |
| local repeated debugging | `session_name: project-user` |
| SSO or existing browser login | `profile: Default` or path |

State/profile/session data is secret. Reference paths only.

## Runner Output

Artifacts live under `outputs/<TC-ID>/<run-id>/`, with `latest` pointing to the
latest run.

Always written: `summary.md`, `result.json`, `console-errors.log`,
`console.log`, `final.png`, `final-annotated.png`.

Conditional: `run.log`, `stepN-before.txt`, `stepN-after.txt`,
`stepN-diff.txt`, `profile.json`.

Failure debug order: `summary.md` -> `stepN-diff.txt` ->
`final-annotated.png` -> `console-errors.log` -> `run.log`.

## Heal

Failed runs classify errors as `selector_drift`, `timing`, `assertion_drift`,
`auth_env`, `app_bug`, `env_error`, or `unknown`.

For selector/timing drift:

1. Read `outputs/<TC-ID>/latest/summary.md`.
2. Run `./browser-test heal <file> <step>` if a live session is useful.
3. Re-resolve from step intent.
4. Patch the cached commands.
5. Validate and run again.

If the issue is auth, permissions, seed data, captcha, outage, or an app bug,
report it instead of weakening the test.

## Logging And Timeouts

`log_level`: `minimal` (default), `normal`, or `verbose`.

- `minimal`: logs/diffs only on failure.
- `normal`: always writes `run.log`; failure diffs only.
- `verbose`: writes logs and before/after/diff for every step.

Each step has a 30 second default budget. Split long loops into bounded steps.
Use `timeout_ms` or `-t` only when one step must be long.

## CLI

```bash
./browser-test new <module> "<title>"
./browser-test discover <url>
./browser-test validate <file|dir>
./browser-test run <file|dir>
./browser-test list [--strict]
./browser-test history [<TC-ID>]
./browser-test heal <file> <step>
./browser-test flaky
./browser-test quarantine [list|add|remove <TC-ID>]
./browser-test coverage
./browser-test eval
./browser-test doctor
```

## CI

Use `./browser-test run tests/ --ci --junit results.xml` for machine output.
Exit code is the gate. Quarantined flows are skipped in folder runs; if
everything is skipped, the run fails to avoid false green. Full CI recipes are
in `docs/CI.md`.

## Coverage

`coverage.map` is one feature per line:

```text
module | Feature name | optional-route-glob
```

A feature counts as covered only when its matching testcase has a current
passing run and is not quarantined. Failing, stale, never-run, or quarantined
tests do not count as covered.

## Flake And Quarantine

`history` and `flaky` read `outputs/history.jsonl`. A flow is considered flaky
only after enough pass/fail oscillation, and only for test-side classes such as
`timing` or `selector_drift`. App bugs and assertion drift are intermittent
defects, not quarantine recommendations.

`quarantine.json` is tracked, has reasons and expiry, and skips only folder
runs. Single-file runs still execute so a quarantined test can be healed.

## Eval

`./browser-test eval` is Papaya's own regression suite. It verifies golden
validator cases, failure classification, flake math, XML safety, quarantine
expiry, and version consistency. Run it after changing validator, classifier,
flake logic, or the contract docs.

## Common False-Green Patterns

Avoid:

- missing `--session "$SESSION"`,
- `sleep`, unreasoned `wait <ms>`, or `read -t`,
- `grep -q .` or unchecked `get`,
- `set +e`, `|| true`, `|| :`, or `trap ERR`,
- hard-coded URLs, credentials, secrets, brittle dates, or test data,
- `expect.url: "**"` or `""`,
- login/signup setup inside non-auth tests,
- positional DOM indexing inside `eval`.
