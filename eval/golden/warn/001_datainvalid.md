---
id: TC-001
title: "Golden warn — data file with unusable lines"
module: datainvalid
session: 001_datainvalid
env: env/env.yaml
state: null
data: eval/golden/data/invalid_data.yaml
techniques: [wait_text]
expect:
  url: null
  text: null
---

# TC-001: data file with unusable lines

## Steps

### 1. Open the home page
- intent: open the home page
- expect: text "Home" visible
```bash
agent-browser --session "$SESSION" open "$base_url"
agent-browser --session "$SESSION" wait --text "Home"
```
