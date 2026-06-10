---
id: TC-003
title: "Golden good — CRLF line endings must parse"
module: crlf
session: 003_crlf
env: env/env.yaml
state: null
data: null
techniques: [semantic_locator, wait_text]
expect:
  url: null
  text: null
---

# TC-001: Golden good case

## Objective
A fully valid testcase used by `./browser-test eval` — it must validate clean.

## Steps

### 1. Open the app home
- intent: load the home page and confirm it rendered
- expect: a visible heading anchors the page
```bash
agent-browser --session "$SESSION" open "$base_url"
agent-browser --session "$SESSION" wait --text "Home"
agent-browser --session "$SESSION" is visible "h1" \
  || { echo "FAIL: no heading rendered"; exit 1; }
```
