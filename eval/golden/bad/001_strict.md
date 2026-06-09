---
id: TC-001
title: "Golden bad — set +e disables strict mode"
module: strict
session: 001_strict
env: env/env.yaml
state: null
data: null
techniques: [wait_text]
expect:
  url: null
  text: null
---

# TC-001: disabled strict mode

## Steps

### 1. Disable strict then assert
- intent: wait for home and confirm
- expect: text "Home"
```bash
set +e
agent-browser --session "$SESSION" wait --text "Home"
```
