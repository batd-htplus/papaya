# state/

Saved browser auth files (cookies + localStorage). Treat as secrets.

`state/*.json` is gitignored — never commit auth files. The `state:` strategy
is the preferred CI/regression auth approach (see docs/REFERENCE.md → Auth
strategies).

Create a state file:

```bash
agent-browser --session setup open https://your-app.example/login
# log in interactively
agent-browser --session setup state save state/shared.auth.json
agent-browser --session setup close
```

Use it in a testcase:

```yaml
state: state/shared.auth.json
```

For encrypted state files:

```bash
export AGENT_BROWSER_ENCRYPTION_KEY=$(openssl rand -hex 32)
```
