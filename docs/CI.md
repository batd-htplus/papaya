# CI integration

Papaya is built to run in a pipeline as a regression gate. Two machine-readable
outputs make that clean:

- `--ci` — quiets human/step logs (and forces `--verbose` off so page output
  can never corrupt the contract) and prints one JSON summary line **prefixed
  with `@@PAPAYA_RESULT@@`**. Parse the line that begins with that marker, not
  "the last line." Fields: `total, executed, passed, failed, errored, skipped,
  zero_executed?, ok, results[]`.
- `--junit <file>` — writes a JUnit XML report most CI systems render natively
  (GitHub Actions, GitLab, Jenkins, CircleCI, Buildkite). Failures use
  `<failure>`, unparsable/crashed flows use `<error>`, quarantined use
  `<skipped>`. All text is stripped of ANSI/control bytes so the report is
  always valid XML 1.0.

The process exit code is the gate: non-zero if any executed flow failed **or
errored**, if a directory run executed **nothing** (e.g. everything was
quarantined — a zero-coverage run must not look green), or — in `--ci` — if a
requested JUnit report could not be written (a missing report is a hard fail, not
a silent green). Quarantined flows are reported as `skipped`. A single malformed
test file no longer aborts the batch: it is recorded as an `error` result and the
report is still written. Even a **pre-flight failure** (empty target, duplicate
TC-IDs, an unexpected throw) still emits the `@@PAPAYA_RESULT@@` line so CI never
fails silently. The summary carries `"ok": <bool>` matching the exit code.

Quarantine entries expire (default 14 days) and auto-return to the gate, so a
stale quarantine can't hide a regression indefinitely; `./browser-test quarantine
list` shows expiry and flags `[EXPIRED]`.

## Quick local check

```bash
./browser-test doctor                              # preflight: node, agent-browser, env, coverage
./browser-test run tests/ --ci --junit results.xml # gate + machine outputs
./browser-test run tests/ -j auto --ci             # parallel across CPUs (big suites)
```

## Parallelism (`-j`)

Testcases are I/O-bound, so for a large suite `-j N` (or `-j auto`) runs N flows
at once, each in its **own isolated child process** — separate agent-browser
session, separate memory, crash-contained. Results are aggregated in input order
(deterministic report) regardless of finish order; JUnit/`--ci` output is
identical to a sequential run. Default is `-j 1` (sequential). Pick N around your
CPU/agent-browser capacity; a single-file run never spawns a worker.

Example `--ci` stdout (one line, prefixed with the marker):

```json
@@PAPAYA_RESULT@@ {"schema_version":2,"runner_version":"1.0.0","total":3,"executed":3,"passed":2,"failed":1,"errored":0,"skipped":0,"ok":false,"results":[{"tc_id":"TC-001","status":"pass","duration_ms":1200,"class":null,"step":null},{"tc_id":"TC-002","status":"fail","duration_ms":900,"class":"selector_drift","step":3}]}
```

## GitHub Actions — regression gate

```yaml
name: browser-it
on: [pull_request]
jobs:
  it:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm i -g agent-browser && agent-browser install
      - run: bash scripts/setup.sh
      - run: ./browser-test doctor
      - name: Run browser IT
        env:
          # secrets, never committed — referenced by tests as $USERNAME etc.
          AGENT_BROWSER_ENCRYPTION_KEY: ${{ secrets.AB_ENC_KEY }}
        run: ./browser-test run tests/ --ci --junit results.xml
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: it-artifacts, path: outputs/ }
      - if: always()
        uses: mikepenz/action-junit-report@v4
        with: { report_paths: results.xml }
```

Auth in CI: prefer a saved `state/*.json` produced once and supplied as an
encrypted secret, or `agent-browser auth`. Never commit credentials or state.

## Trust model — preventing un-run / wrong testcases

A skill cannot force an LLM to run anything. The thorough defense is to **stop
trusting the agent and trust only what a deterministic gate re-produces.** Layers:

1. **Static gate (no run):** `validate` rejects structurally-wrong testcases
   (missing `--session`, weak/swallowed assertions, hard-coded values, …).
2. **Proof-of-execution gate:** `list --strict` exits non-zero unless every
   testcase has a **passing run of its current bytes** on record. A testcase the
   agent wrote but never ran shows `UNVERIFIED`; one edited after its last pass
   shows `STALE`. Both fail the gate — "not run = not done".
3. **Independent re-run:** CI runs `run tests/ --ci` in a **clean environment the
   agent doesn't control**, so the agent's "it passed for me" is irrelevant — the
   gate re-executes from scratch.
4. **The skill self-test:** `eval` proves the gate itself isn't broken.

Recommended gate (block merge unless all pass):

```bash
./browser-test validate tests/        # structure
./browser-test list --strict          # every testcase has a fresh passing run
./browser-test run tests/ --ci        # independent re-execution
./browser-test eval                   # the gate is intact
```

For a local pre-commit hook (catch it before CI):

```bash
# .git/hooks/pre-commit
./browser-test validate tests/ && ./browser-test list --strict || {
  echo "Testcases are unverified/stale — run them before committing."; exit 1; }
```

The model variance ("some AIs run and get it right, others don't and ship wrong
testcases") is absorbed here: a non-running agent leaves `UNVERIFIED`/`STALE`
artifacts that the gate rejects, and a wrong-but-passing testcase is blocked by
the static false-green rules. Nothing reaches `main` on the agent's word alone.

## Two gates, two jobs

1. **Project regression** — `./browser-test run tests/ --ci` gates app PRs.
2. **Skill self-test** — `./browser-test eval` gates changes to Papaya itself
   (validator, classifier, flake logic). Wire it in the skill's own repo so a
   regression in the tooling is caught before it reaches any project.

```yaml
  skill-eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: ./browser-test eval
```
