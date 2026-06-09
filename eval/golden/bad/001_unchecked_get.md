---
id: TC-001
title: "Golden bad — unchecked get"
module: uncheckedget
session: 001_unchecked_get
env: env/env.yaml
state: null
data: null
techniques: [wait_text]
expect:
  url: null
  text: null
---

# TC-001: unchecked get

## Steps

### 1. Read URL without checking it
- intent: inspect the current URL
- expect: URL is checked by a real assertion
```bash
agent-browser --session "$SESSION" get url
```
