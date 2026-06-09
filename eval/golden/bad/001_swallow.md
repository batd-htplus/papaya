---
id: TC-001
title: "Golden bad — || true swallows failure"
module: swallow
session: 001_swallow
env: env/env.yaml
state: null
data: null
techniques: [wait_text]
expect:
  url: null
  text: null
---

# TC-001: swallowed exit

## Steps

### 1. Assert but swallow
- intent: wait for home and confirm
- expect: text "Home"
```bash
agent-browser --session "$SESSION" wait --text "Home" || true
```
