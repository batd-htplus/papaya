# USAGE.md — End-user prompt patterns

Prompts the user types; behaviour the LLM should follow when this skill is
loaded. Project-agnostic phrasing.

## Write a new testcase

> Write IT for the login flow using credentials from env.

LLM should:
1. Scaffold the file: `./browser-test new login "Login with valid creds"` —
   this generates the correct id/session/frontmatter so the shape is identical
   no matter which agent writes it. Read `AGENTS.md`.
2. Explore the login flow live via `agent-browser` until it passes. Use
   `snapshot -i` to understand the UI and `@eN` refs for immediate actions, but
   prefer stable test attributes and semantic locators in the saved testcase.
3. Fill the scaffold's `<PLACEHOLDER>`s with commands that already passed;
   replace literals with `$base_url`, `$username`, ... (keep the generated id).
4. Run `validate` + `run`. Report PASS/FAIL + artifacts path.

## Run regression

> Re-run all testcases in the checkout module.

LLM should:
1. `./browser-test list` to enumerate testcases.
2. `./browser-test run tests/` (or filter glob like `tests/checkout-*.md`).
3. Report results; link failures to `outputs/<TC>/latest/summary.md`.

## Fix a failing testcase

> Test `003_checkout` is failing. Fix it.

LLM should:
1. Read `outputs/TC-003/latest/summary.md`, `stepN-diff.txt`,
   `console-errors.log`, `final-annotated.png` (in that order).
2. Re-explore the failing step live to confirm new selector/wait.
3. Patch testcase. `validate` + `run`. Stop if blocked (login expired,
   captcha, site down) — report, never fabricate.

## Audit coverage

> Which modules of the project don't have IT yet?

LLM should:
1. `./browser-test coverage` — if `coverage.map` exists, this reports covered
   features, gaps, and a coverage %. (Copy `coverage.map.example` to start.)
2. Otherwise `./browser-test list` to enumerate covered modules and compare with
   the project's route/feature list (ask the user if unknown).
3. Report gaps. Do NOT write new tests unless asked.

## Update after UI change

> Login page changed the "Email" field to "Username". Update tests.

LLM should:
1. `rg -l "Email" tests/` to find affected testcases.
2. Re-explore live to confirm new selector.
3. Patch + `validate` + `run`. Stop on ambiguity, ask user.

## Inspect history

> Which tests failed the most this past week?

LLM should:
1. `./browser-test history` (all) or per `<TC-ID>` for recent runs + flake %.
2. `./browser-test flaky` to score oscillating flows and get quarantine advice.
3. Summarise pass/fail counts; suggest quarantining genuinely flaky tests until
   the root cause (usually a missing signal-based wait) is healed.

## Long-running or repeated-action tests

> Reload the page 1000 times / run this for 30 minutes.

LLM should:
1. Note that each step has a 30 s budget; a giant loop in one step will time out
   with class `timing`.
2. Prefer splitting the loop across steps (bounded batches) for progress + per-
   batch diagnosis; otherwise set `timeout_ms:` in frontmatter (e.g. `1800000`).
3. Keep soak/stress tests out of the PR gate — run them on their own file/
   schedule. Full guidance: `docs/REFERENCE.md → Long-running / repeated-action
   tests`.

## Write a test that needs the user already logged in

> Write IT for the checkout flow. The user should already be authenticated.

LLM should:
1. Check whether a saved auth state exists: `ls state/`.
2. If none exists: create auth with the lightest suitable mechanism: saved
   state, `session_name`, Chrome `profile`, or `agent-browser auth`. For saved
   state, run login once and save it with `agent-browser --session "$SESSION"
   state save state/checkout_user.auth.json`. Commit the filename only.
3. Scaffold the new testcase with `./browser-test new <module> "<title>"`.
4. Set `state: state/checkout_user.auth.json` in the frontmatter — the browser
   starts authenticated; **no signup or login steps needed**.
5. Explore the checkout flow live. Snapshot when the UI changes or before using
   `@eN` refs; save durable locators where possible.
6. Fill placeholders, validate, run. Report PASS + artifacts path.

**Never** embed a full signup/login as Step 1 of a non-auth testcase. It adds
15–20 s of network-dependent noise and creates an invisible dependency on the
signup flow being stable.

## What NOT to ask the skill

- "Write a test that always passes." — violates the validator-enforced rules.
- "Disable the validator / bypass `grep -q .` rule." — violates the validator-enforced rules.
- "Use my password `xxx` here." — paste a cookies/state file path or use
  `agent-browser auth` instead.
