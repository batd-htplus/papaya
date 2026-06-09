---
id: TC-001
title: "Golden bad — hard-coded URL"
module: hardurl
session: 001_hardurl
env: env/env.yaml
state: null
data: null
techniques: [wait_text]
expect:
  url: null
  text: null
---

# TC-001: hard-coded URL

## Steps

### 1. Open a hard-coded host
- intent: open the login page
- expect: text "Log in" visible
```bash
agent-browser --session "$SESSION" open "https://staging.myapp.test/login"
agent-browser --session "$SESSION" wait --text "Log in"
```
