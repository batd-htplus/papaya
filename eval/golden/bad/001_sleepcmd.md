---
id: TC-001
title: "Golden bad — forbidden bash sleep"
module: sleepcmd
session: 001_sleepcmd
env: env/env.yaml
state: null
data: null
techniques: [wait_text]
expect:
  url: null
  text: null
---

# TC-001: bash sleep

## Steps

### 1. Open with a blind sleep
- intent: open the home page and wait for it
- expect: text "Home" visible
```bash
agent-browser --session "$SESSION" open "$base_url"
sleep 2
agent-browser --session "$SESSION" wait --text "Home"
```
