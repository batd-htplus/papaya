---
id: TC-002
title: "Golden good — validator precision"
module: validator
session: 002_validator_precision
env: env/env.yaml
state: null
data: null
techniques: [wait_text, semantic_locator]
expect:
  url: null
  text: null
---

# TC-002: validator precision

## Objective
Valid command forms from the version-matched agent-browser core guide should not
trip false positives.

## Steps

### 1. Short session flag and justified visual pause
- intent: load the app and wait for the home text
- expect: "Home" appears after the page settles
```bash
agent-browser -s "$SESSION" open "$base_url"
agent-browser -s "$SESSION" wait 250 # brief paint settle before checking text
agent-browser -s "$SESSION" wait --text "Home"
```

### 2. Checked get output
- intent: read the current URL and assert it is from the configured app
- expect: current URL contains the configured base URL host
```bash
current_url="$(agent-browser --session "$SESSION" get url)"
[[ "$current_url" == "$base_url"* ]] \
  || { echo "FAIL: current URL is outside base_url"; exit 1; }
```
