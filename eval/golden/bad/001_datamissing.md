---
id: TC-001
title: "Golden bad — data file does not exist"
module: datamissing
session: 001_datamissing
env: env/env.yaml
state: null
data: tests/data/does_not_exist.yaml
techniques: [wait_text]
expect:
  url: null
  text: null
---

# TC-001: data file does not exist

## Steps

### 1. Open the home page
- intent: open the home page
- expect: text "Home" visible
```bash
agent-browser --session "$SESSION" open "$base_url"
agent-browser --session "$SESSION" wait --text "Home"
```
