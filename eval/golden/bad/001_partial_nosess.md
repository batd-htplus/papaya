---
id: TC-001
title: "Golden bad — partial missing session"
module: partialnosess
session: 001_partial_nosess
env: env/env.yaml
state: null
data: null
techniques: [wait_text]
expect:
  url: null
  text: null
---

# TC-001: partial missing session

## Steps

### 1. One command omits the session
- intent: open the home page and confirm text
- expect: text "Home" visible
```bash
agent-browser --session "$SESSION" open "$base_url"
agent-browser wait --text "Home"
```
