# USAGE.md - Prompt playbook

Use this file for user intent. Use `AGENTS.md` for the contract and
`agent-browser skills get core --full` for browser command syntax.

## Write A New Test

User: "Write IT/e2e for login/checkout/etc."

1. Run `./browser-test new <module> "<title>"`.
2. Read `AGENTS.md` and load the agent-browser core guide.
3. Explore live until the flow passes.
4. Save only proven commands with durable locators and project variables.
5. Run `./browser-test validate tests/<file>.md` and
   `./browser-test run tests/<file>.md`.
6. Report PASS/FAIL and artifacts path.

## Run Regression

User: "Run/re-run tests."

1. Use `./browser-test list` to see available cases.
2. Run the requested file or folder with `./browser-test run ...`.
3. Report the result summary. For failures, point to
   `outputs/<TC-ID>/latest/summary.md`.

## Fix A Failing Test

User: "Fix test TC-..." or "checkout test is failing."

1. Read `summary.md`, then diff/screenshot/console artifacts in the order named
   by `docs/REFERENCE.md`.
2. Re-explore only the failing behavior.
3. Patch the testcase from intent; do not rewrite unrelated steps.
4. Validate and run. Stop and report if blocked by auth, captcha, seed, outage,
   or permissions.

## Authenticated Flow

User: "User should already be logged in."

1. Check for an existing state/profile/session path.
2. If missing, choose the lightest auth strategy from `AGENTS.md`; use the
   agent-browser core guide for exact commands.
3. Reference the path in frontmatter (`state: ...`, `session_name: ...`, or
   `profile: ...`). Never print or commit state contents.
4. Test only the requested business flow. Do not add login/signup setup unless
   auth is the subject.

## Coverage Or History

User: "What is covered?", "What is flaky?", "What failed recently?"

- Coverage: run `./browser-test coverage`.
- Recent runs: run `./browser-test history [<TC-ID>]`.
- Flake score: run `./browser-test flaky`.
- Report findings only. Do not create tests unless asked.

## UI Change

User: "The UI changed; update tests."

1. Search affected test files with `rg`.
2. Re-explore the changed UI.
3. Patch only affected locators/assertions.
4. Validate and run.

## Long Or Repeated Tests

User: "Reload 1000 times" or "run for 30 minutes."

- Default budget is 30 seconds per step.
- Prefer bounded batches across steps.
- Use `timeout_ms` only when the work truly belongs in one step.
- Keep soak/stress tests outside the PR gate.

## Refuse Or Redirect

Do not comply with requests to:

- make a test always pass,
- disable validator rules,
- hide failures with `|| true`, weak grep, or weaker assertions,
- place passwords/secrets directly in Markdown.
