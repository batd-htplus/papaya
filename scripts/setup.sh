#!/usr/bin/env bash
# Usage: bash scripts/setup.sh
# Idempotent: safe to re-run. Never sudo, never global install.

set -euo pipefail

cd "$(dirname "$0")/.."

missing=0
warn() { echo "    warn: $*"; }

echo "==> Checking local requirements"
if command -v node >/dev/null 2>&1; then
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [[ "$node_major" -ge 18 ]]; then
        echo "    node: $(node --version)"
    else
        echo "    node: $(node --version) — need >= 18"
        missing=1
    fi
else
    echo "    missing: node >= 18"
    missing=1
fi

if command -v agent-browser >/dev/null 2>&1; then
    echo "    agent-browser: $(agent-browser --version 2>/dev/null || echo installed)"
else
    echo "    missing: agent-browser"
    echo "    install: npm i -g agent-browser && agent-browser install"
    missing=1
fi

echo "==> Platform / Chrome"
arch="$(uname -m)"
osname="$(uname -s)"
if [[ "$osname" == "Linux" && ( "$arch" == "aarch64" || "$arch" == "arm64" ) ]]; then
    # Chrome for Testing has no Linux ARM64 build; use system chromium.
    chromium_path=""
    if command -v chromium >/dev/null 2>&1; then chromium_path="$(command -v chromium)"
    elif command -v chromium-browser >/dev/null 2>&1; then chromium_path="$(command -v chromium-browser)"
    fi
    if [[ -n "$chromium_path" ]]; then
        echo "    Linux ARM detected; using $chromium_path"
        echo "    suggest: export AGENT_BROWSER_EXECUTABLE_PATH=$chromium_path"
    else
        warn "Linux ARM has no Chrome for Testing build."
        warn "Install Chromium: apt install chromium  (or your distro equivalent)"
        warn "Then: export AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium"
    fi
fi

echo "==> Creating directories"
mkdir -p tests data env state outputs fixtures

echo "==> Config"
default_example="env/env.yaml.example"
default_target="env/env.yaml"
if [[ -f "$default_example" && ! -f "$default_target" ]]; then
    cp "$default_example" "$default_target"
    echo "    Created env/env.yaml from example — edit project defaults there"
fi

local_example="env/env.local.yaml.example"
local_target="env/env.local.yaml"
if [[ -f "$local_example" && ! -f "$local_target" ]]; then
    cp "$local_example" "$local_target"
    echo "    Created env/env.local.yaml — edit local secrets there"
fi

if [[ -f "coverage.map.example" && ! -f "coverage.map" ]]; then
    cp "coverage.map.example" "coverage.map"
    echo "    Created coverage.map from example — list your app's features there"
fi

echo "==> Encryption key for auth state"
if [[ -z "${AGENT_BROWSER_ENCRYPTION_KEY:-}" ]]; then
    echo "    suggest: export AGENT_BROWSER_ENCRYPTION_KEY=\$(openssl rand -hex 32)"
    echo "    (encrypts state/*.json at rest; put in shell rc / CI secret)"
fi

echo "==> .gitignore"
if [[ ! -f .gitignore ]] || ! grep -q "Papaya skill" .gitignore 2>/dev/null; then
    [[ -f .gitignore ]] && printf "\n" >> .gitignore
    cat >> .gitignore <<'EOF'
# === Papaya skill — required ignores ===
outputs/
env/*.local.yaml
env/*.local.yml
data/*.local.yaml
data/*.local.yml
state/*.json
profile.json
# === end Papaya ===
EOF
    echo "    Added Papaya ignore entries to .gitignore"
else
    echo "    Papaya ignore entries already present in .gitignore"
fi

echo "==> Runner"
chmod +x browser-test scripts/browser-test-runner.mjs

echo ""
sample=$(ls tests/*.md 2>/dev/null | head -1)

if [[ "$missing" -ne 0 ]]; then
    echo "Setup finished with missing requirements above. Install them, then re-run this script."
    exit 1
fi

echo "Done. Try:"
echo "  ./browser-test doctor"
echo "  ./browser-test list"
if [[ -n "$sample" ]]; then
    echo "  ./browser-test validate $sample"
    echo "  ./browser-test run     $sample"
else
    # No testcases yet — scaffold the first one (correct id/session/filename).
    echo "  ./browser-test new <module> \"<title>\"   # scaffold your first testcase"
fi
