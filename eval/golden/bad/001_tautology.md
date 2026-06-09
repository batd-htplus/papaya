---
id: TC-001
title: "Golden bad — tautology expect matches anything"
module: tautology
session: 001_tautology
env: env/env.yaml
state: null
data: null
techniques: [wait_text]
expect:
  url: "**"
  text: null
---

# TC-001: tautology expect

## Steps

### 1. Real step, fake final check
- intent: wait for home and confirm
- expect: text "Home"
```bash
agent-browser --session "$SESSION" wait --text "Home"
```
