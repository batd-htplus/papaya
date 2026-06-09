---
id: TC-001
title: "Golden bad — weak grep that always passes"
module: weakgrep
session: 001_weakgrep
env: env/env.yaml
state: null
data: null
techniques: [semantic_locator]
expect:
  url: null
  text: null
---

# TC-001: weak grep

## Steps

### 1. Open and fake-assert
- intent: open the home page
- expect: (intentionally weak — this is the rule under test)
```bash
agent-browser --session "$SESSION" open "$base_url"
agent-browser --session "$SESSION" get url | grep -q .
```
