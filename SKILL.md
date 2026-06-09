---
name: papaya
description: Browser control skill for LLM agents — drive a real browser reliably and save explored flows as re-runnable Markdown. Use when the user asks to write, run, fix, list, or regression-check browser end-to-end flows (IT/e2e) for a web application. Triggers include "write IT", "write integration test", "add e2e test", "test login/checkout flow", "run regression", "re-run testcase", "fix test fail", "list testcases".
version: 1.0.0
requires:
  - agent-browser >= 0.27
  - node >= 18
  - bash
contract_version: 1
---

# Papaya — Browser Skill for LLM Agents

A copy-into-project skill that teaches an LLM agent to **drive a real browser
reliably** with `agent-browser`, then save the verified flow as a re-runnable
Markdown file. The agent is the actor; `browser-test` is a tool it reaches for.
Flows live as Markdown under `tests/`; re-running a flow later **is** the regression.

## Read order (LLM)

1. [`AGENTS.md`](./AGENTS.md) — contract: two-phase workflow + validator-enforced rules. **Read first.**
2. [`docs/USAGE.md`](./docs/USAGE.md) — end-user prompt patterns.
3. [`docs/REFERENCE.md`](./docs/REFERENCE.md) — full detail (on demand only).

Human setup/install: see [`README.md`](./README.md). `./browser-test` (no args
or `--help`) lists every command.
