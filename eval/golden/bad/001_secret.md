---
id: TC-001
title: "Golden bad — secret in frontmatter"
module: secret
session: 001_secret
env: env/env.yaml
state: null
data: null
techniques: [wait_text]
password: hunter2
expect:
  url: null
  text: null
---

# TC-001: secret in frontmatter

## Steps

### 1. Open the home page
- intent: open the home page
- expect: text "Home" visible
```bash
agent-browser --session "$SESSION" open "$base_url"
agent-browser --session "$SESSION" wait --text "Home"
```
