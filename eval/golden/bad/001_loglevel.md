---
id: TC-001
title: "Golden bad — invalid log_level"
module: loglevel
session: 001_loglevel
env: env/env.yaml
state: null
data: null
techniques: [wait_text]
log_level: debug
expect:
  url: null
  text: null
---

# TC-001: invalid log_level

## Steps

### 1. Open the home page
- intent: open the home page
- expect: text "Home" visible
```bash
agent-browser --session "$SESSION" open "$base_url"
agent-browser --session "$SESSION" wait --text "Home"
```
