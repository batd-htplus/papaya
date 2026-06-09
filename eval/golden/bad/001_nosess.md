---
id: TC-001
title: "Golden bad — missing --session"
module: nosess
session: 001_nosess
env: env/env.yaml
state: null
data: null
techniques: [semantic_locator]
expect:
  url: null
  text: null
---

# TC-001: missing session

## Steps

### 1. Open without session
- intent: open the home page
- expect: url contains example.com
```bash
agent-browser open "$base_url"
agent-browser get url | grep -q 'example.com'
```
