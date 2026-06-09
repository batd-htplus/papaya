---
id: TC-001
title: "Golden bad — bare wait with short session flag"
module: barewait
session: 001_barewait_shortflag
env: env/env.yaml
state: null
data: null
techniques: [wait_text]
expect:
  url: null
  text: null
---

# TC-001: bare wait with short session flag

## Steps

### 1. Blind wait without reason
- intent: wait for home and confirm
- expect: text "Home"
```bash
agent-browser -s "$SESSION" wait 1000
agent-browser -s "$SESSION" wait --text "Home"
```
