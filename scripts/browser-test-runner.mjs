#!/usr/bin/env node
import {
    appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
    readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync,
    writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";

/**
 * Papaya browser-test runner — validate and execute Markdown browser testcases.
 * @module browser-test-runner
 */

function fileSha(path) {
    try { return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12); }
    catch { return null; }
}

// Absolute path to this script — re-spawned as a per-testcase worker in -j mode.
const SCRIPT_PATH = fileURLToPath(import.meta.url);

// Project root = parent of scripts/. All test/env/output paths resolve from here.
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const VERSION = "1.0.0";
const CONTRACT_VERSION = 1; // bump when the testcase contract (frontmatter/step shape) changes incompatibly

const ALLOWED_TECHNIQUES = new Set([
    "semantic_locator", "css_locator", "snapshot_ref", "network_route",
    "state_load", "wait_url", "wait_text", "wait_load", "wait_fn",
    "eval_stdin", "react_devtools",
]);

const LOG_LEVELS = new Set(["minimal", "normal", "verbose"]);

const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const XML_ILLEGAL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
function cleanText(s) {
    return String(s ?? "").replace(ANSI_RE, "").replace(XML_ILLEGAL_RE, "");
}

const HISTORY_FILE = () => resolve(ROOT, "outputs", "history.jsonl");
const QUARANTINE_FILE = () => resolve(ROOT, "quarantine.json");
const FLAKE_WINDOW = 20;        // recent runs considered
const FLAKE_THRESHOLD = 0.34;   // >= ~1/3 pass/fail flips ⇒ flaky

function usage() {
    console.log(`browser-test runner v${VERSION}

Usage:
  ./browser-test run [options] <file-or-dir>     run testcase(s)
  ./browser-test validate <file-or-dir>          static checks
  ./browser-test new <module> ["title"]          scaffold a testcase; asks auth/data questions
  ./browser-test discover <url>                  list testable locators on a page (data-qa, placeholders, roles)
  ./browser-test list [--strict]                 testcases + status (UNVERIFIED = never run; --strict gates it)
  ./browser-test history [<TC-ID>]               recent run history (+ flake)
  ./browser-test heal <file> <step>              heal brief: intent + live snapshot
  ./browser-test flaky                           flake scores + quarantine advice
  ./browser-test quarantine [list | add <TC-ID> [--reason "why"] [--days N] | remove <TC-ID>]
  ./browser-test coverage                        features tested vs gaps
  ./browser-test eval                            self-test the skill's machinery
  ./browser-test doctor                          preflight + agent-browser doctor

Options for run:
  -j, --jobs <N|auto>      Run N testcases in parallel (default 1; isolated child procs)
      --include-quarantined  Run quarantined flows too (batch runs)
      --ci                   Quiet logs; emit a JSON summary to stdout
      --junit <file>         Also write JUnit XML for CI test reporting
  -s, --session <name>     Override session
  -e, --env <file>         Override env defaults file
  -t, --timeout <sec>      Per step timeout in seconds (default 30s)
  -v, --verbose            Print command output (forces log_level=verbose)
      --log-level <lvl>    minimal | normal | verbose
      --no-teardown        Keep browser session open
      --no-diff            Disable snapshot diff around steps
      --profiler           Capture Chrome profile to profile.json
      --report <file>      Also write result JSON to this path
`);
}

function parseArgs(argv) {
    if (argv[2] === "-h" || argv[2] === "--help" || !argv[2]) { usage(); process.exit(0); }
    const out = { command: argv[2], file: "", verbose: false, noTeardown: false, noDiff: false, profiler: false, report: "" };
    const args = argv.slice(3);
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-h" || a === "--help") { usage(); process.exit(0); }
        if (a === "-v" || a === "--verbose") { out.verbose = true; continue; }
        if (a === "--no-teardown") { out.noTeardown = true; continue; }
        if (a === "--no-diff") { out.noDiff = true; continue; }
        if (a === "--include-quarantined") { out.includeQuarantined = true; continue; }
        if (a === "--ci") { out.ci = true; continue; }
        if (a === "--junit") { out.junit = args[++i]; continue; }
        // Accept attached / `=` forms too: -j4, -jauto, --jobs=4, --junit=x.xml.
        if (a.startsWith("--jobs=")) { out.jobs = a.slice(7); continue; }
        if (/^-j.+/.test(a)) { out.jobs = a.slice(2); continue; }
        if (a === "-j" || a === "--jobs") { out.jobs = args[++i]; continue; }
        if (a.startsWith("--junit=")) { out.junit = a.slice(8); continue; }
        if (a === "--strict") { out.strict = true; continue; }
        if (a === "--profiler") { out.profiler = true; continue; }
        if (a === "-s" || a === "--session") { out.session = args[++i]; continue; }
        if (a === "-e" || a === "--env") { out.env = args[++i]; continue; }
        if (a === "-t" || a === "--timeout") { out.timeout = Number(args[++i]); continue; }
        if (a === "--log-level") { out.logLevel = String(args[++i]); continue; }
        if (a === "--report") { out.report = args[++i]; continue; }
        // Consumed by the quarantine subcommand (parsed there from argv); accept
        // here so the global parser doesn't reject them.
        if (a === "--reason") { out.reason = args[++i]; continue; }
        if (a === "--days") { out.days = args[++i]; continue; }
        if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        out.file = a;
    }
    return out;
}

function parseScalar(v) {
    v = String(v ?? "").trim();
    if (v === "null") return null;
    if (v === "true") return true;
    if (v === "false") return false;
    // Only treat as a number when it round-trips exactly — keeps leading-zero
    // values (postal codes, phone numbers, zero-padded ids) intact as strings.
    if (/^\d+$/.test(v)) { const n = Number(v); return (String(n) === v && Number.isSafeInteger(n)) ? n : v; }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    if (v.startsWith("[") && v.endsWith("]")) {
        const body = v.slice(1, -1).trim();
        return body ? body.split(",").map((x) => parseScalar(x.trim())) : [];
    }
    return v;
}

function stripComment(line) {
    let inQuote = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuote) {
            if (ch === inQuote) inQuote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { inQuote = ch; continue; }
        if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
            return line.slice(0, i).replace(/\s+$/, "");
        }
    }
    return line;
}

function parseSimpleYaml(text) {
    const obj = {};
    let parent = null;
    for (const raw of text.split(/\r?\n/)) {
        const noComment = stripComment(raw);
        if (!noComment.trim()) continue;
        const nested = noComment.match(/^  ([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
        if (nested && parent) {
            obj[parent][nested[1]] = parseScalar(nested[2]);
            continue;
        }
        const top = noComment.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
        if (!top) continue;
        parent = null;
        if (top[2] === "") {
            obj[top[1]] = {};
            parent = top[1];
        } else {
            obj[top[1]] = parseScalar(top[2]);
        }
    }
    return obj;
}

function readEnv(file) {
    if (!file || !existsSync(file)) return {};
    return parseSimpleYaml(readFileSync(file, "utf8"));
}

function readCase(file) {
    if (!existsSync(file)) throw new Error(`File not found: ${file}`);
    const md = readFileSync(file, "utf8");
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) throw new Error("Missing YAML frontmatter");
    return { md, meta: parseSimpleYaml(fm[1]), steps: parseSteps(md) };
}

function parseSteps(md) {
    const body = md.replace(/^---\n[\s\S]*?\n---/, "");
    const parts = body.split(/^###\s+\d+\.\s+/m).slice(1);
    const steps = [];
    for (const part of parts) {
        const lines = part.split(/\r?\n/);
        const name = lines.shift().trim();
        const content = lines.join("\n");
        const blocks = [...content.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => m[1].trim()).filter(Boolean);
        // intent/expect come from the bullet lines before the bash block. intent
        // is the real goal; the bash is a cache of it that can be re-resolved.
        const preCode = content.split(/```bash/)[0];
        const intent = preCode.match(/^\s*[-*]?\s*intent\s*:\s*(.+)$/im)?.[1]?.trim() || "";
        const expect = preCode.match(/^\s*[-*]?\s*expect\s*:\s*(.+)$/im)?.[1]?.trim() || "";
        steps.push({ name, code: blocks.join("\n\n"), intent, expect });
    }
    if (!steps.length) throw new Error("No steps found. Use headings: ### 1. Open page");
    return steps;
}

function classifyError(error, consoleErrors = "") {
    const e = String(error || "").toLowerCase();
    // env_error before selector_drift ("command not found" is not DOM drift)
    if (/command not found|: not found$|enoent|no such file or directory|eacces|permission denied|operation not permitted|not writable|socket directory|not installed|cannot find module/.test(e)) {
        return { class: "env_error", hint: "Tooling/environment problem (missing binary, PATH, or permission). Run ./browser-test doctor; fix the runner host, not the test." };
    }
    if (/state file not found|\b401\b|\b403\b|unauthor|login|auth|session expired/.test(e)) {
        return { class: "auth_env", hint: "Auth/state/seed problem. Re-establish login or fix env; do NOT fabricate. Stop and report blocked." };
    }
    // app_bug before selector_drift
    if (/\b5\d\d\b|server error|uncaught|unhandled|exception|traceback/.test(`${e} ${String(consoleErrors).toLowerCase()}`)) {
        return { class: "app_bug", hint: "Looks like an application defect (5xx / console error). Capture repro and surface as a candidate bug." };
    }
    if (/timeout|timed out|timedout|etimedout|deadline|waiting for|exceeded the per-step/.test(e)) {
        return { class: "timing", hint: "Step took too long / element arrived late. Raise -t or 'timeout_ms', split a huge loop into steps, or use a signal-based wait (--text/--url/--load/--fn) instead of a blind sleep." };
    }
    if (/element not found|no element|could not find|not visible|no match|0 elements|stale|detached/.test(e)) {
        return { class: "selector_drift", hint: "Element moved or was renamed. Re-resolve from the step's intent: ./browser-test heal <file> <step>." };
    }
    if (/mismatch|expected=|assert/.test(e)) {
        return { class: "assertion_drift", hint: "A declared expectation did not hold. Confirm with the director: real change, or a defect?" };
    }
    // explicit FAIL: guard → assertion_drift
    if (/(^|\s)fail:/.test(e)) {
        return { class: "assertion_drift", hint: "A step guard asserted a condition that did not hold. Re-explore the step; confirm whether the app changed or regressed." };
    }
    return { class: "unknown", hint: "Read summary.md → stepN-diff.txt → final-annotated.png → console-errors.log in order." };
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildShellEnv(vars) {
    return Object.entries(vars)
        .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v !== null && v !== undefined)
        .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
        .join("\n");
}

function writeJson(file, value) {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Atomically repoint the 'latest' symlink: create a temp link then rename, so a
// crash mid-swap never leaves 'latest' dangling. Falls back to unlink+symlink.
function ensureLatestSymlink(latest, target) {
    const tmp = `${latest}.tmp${process.pid}`;
    try { unlinkSync(tmp); } catch { }
    try {
        symlinkSync(target, tmp);
        renameSync(tmp, latest);
    } catch {
        try { unlinkSync(tmp); } catch { }
        try { unlinkSync(latest); } catch { }
        try { symlinkSync(target, latest); } catch { }
    }
}

// A testcase file under tests/; names starting with "_" are templates, skipped.
function isTestFile(f) { return f.endsWith(".md") && !f.startsWith("_"); }

function expandFiles(input) {
    if (!input) return [];
    const p = resolve(ROOT, input);
    if (!existsSync(p)) return [];
    if (statSync(p).isDirectory()) {
        return readdirSync(p).filter(isTestFile).map(f => join(p, f)).sort();
    }
    return [p];
}

class Runner {
    constructor(opts, tc) {
        this.opts = opts;
        this.tc = tc;
        this.meta = tc.meta;
        this.session = opts.session || this.meta.session;
        if (!this.session) throw new Error("Missing session");
        this.timeoutMs = opts.timeout != null && opts.timeout !== ""
            ? Number(opts.timeout) * 1000
            : Number(this.meta.timeout_ms ?? 30000);
        this.profiler = Boolean(opts.profiler || this.meta.profiler);
        this.steps = [];
        this.failed = null;
        this.logBuffer = "";
        this.persistLog = false;
        this.snapshotEveryStep = false;
        this.logLevel = "minimal";
    }

    resolveLogLevel(envVars) {
        const raw = String(
            this.opts.logLevel
            || this.meta.log_level
            || envVars.LOG_LEVEL
            || envVars.log_level
            || "minimal"
        ).toLowerCase();
        const level = LOG_LEVELS.has(raw) ? raw : "minimal";
        return this.opts.verbose ? "verbose" : level;
    }

    appendLog(text) {
        if (!text) return;
        const tail = text.endsWith("\n") ? text : `${text}\n`;
        if (this.persistLog) appendFileSync(this.logFile, tail);
        else this.logBuffer += tail;
    }

    flushBufferedLog() {
        if (this.persistLog) return;
        writeFileSync(this.logFile, this.logBuffer);
        this.logBuffer = "";
        this.persistLog = true;
    }

    vars() {
        if (!this._envLayer) {
            const envFile = this.opts.env || this.meta.env || "env/env.yaml";
            const defaults = readEnv(resolve(ROOT, envFile));
            const local = readEnv(resolve(ROOT, dirname(envFile), "env.local.yaml"));
            const data = this.meta.data ? readEnv(resolve(ROOT, String(this.meta.data))) : {};
            const dataLocal = this.meta.data
                ? readEnv(resolve(ROOT, dirname(String(this.meta.data)),
                    `${basename(String(this.meta.data), ".yaml")}.local.yaml`))
                : {};
            this._envLayer = { ...defaults, ...local, ...data, ...dataLocal };
        }
        const vars = { ...process.env, ...this._envLayer }; // env/data beat ambient CI vars
        vars.SESSION = this.session;
        vars.TC_ID = this.meta.id;
        vars.RUN_DIR = this.runDir;
        vars.DOWNLOAD_DIR = join(ROOT, "outputs", this.meta.id, "downloads");
        if (this.meta.profile) vars.AGENT_BROWSER_PROFILE = String(this.meta.profile);
        if (this.meta.session_name) vars.AGENT_BROWSER_SESSION_NAME = String(this.meta.session_name);
        if (this.meta.headless === false) vars.AGENT_BROWSER_HEADED = "1";
        if (this.meta.color_scheme) vars.AGENT_BROWSER_COLOR_SCHEME = String(this.meta.color_scheme);
        vars.AGENT_BROWSER_DOWNLOAD_PATH = vars.DOWNLOAD_DIR;
        // Keep agent-browser's own per-operation timeout in step with the per-step
        // budget: its default is 25s, so a single long wait the user deliberately
        // allowed (timeout_ms/-t > 30s) would otherwise be killed early. At/below
        // 30s we leave agent-browser's tuned default — it sits just under the 30s
        // IPC read limit, and raising it past 30s risks EAGAIN.
        if (this.timeoutMs > 30000) vars.AGENT_BROWSER_DEFAULT_TIMEOUT = String(this.timeoutMs);
        return vars;
    }

    ab(args, options = {}) {
        const res = spawnSync("agent-browser", ["--session", this.session, ...args], {
            cwd: ROOT,
            encoding: "utf8",
            timeout: this.timeoutMs,
            maxBuffer: 20 * 1024 * 1024,
        });
        const out = `${res.stdout || ""}${res.stderr || ""}`;
        if (out) this.appendLog(out);
        if (!options.allowFail && (res.error || res.status !== 0)) {
            throw new Error(this.spawnErrorMessage(res, out));
        }
        return { ...res, output: out };
    }

    spawnErrorMessage(res, out) {
        const timedOut = res.error?.code === "ETIMEDOUT" || res.signal === "SIGTERM";
        if (timedOut) {
            const sec = Math.round(this.timeoutMs / 1000);
            return `step exceeded the per-step timeout (${sec}s). Raise it with -t <seconds> or 'timeout_ms:' in frontmatter, or split this step into smaller steps (a 1000-iteration loop in one step will blow the budget).`;
        }
        return res.error?.message || out.trim().split(/\r?\n/).slice(-1)[0] || `exit ${res.status}`;
    }

    setup() {
        if (!this.meta.id) throw new Error("Missing id");
        const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        this.runDir = join(ROOT, "outputs", this.meta.id, stamp);
        mkdirSync(this.runDir, { recursive: true });
        mkdirSync(join(ROOT, "outputs", this.meta.id, "downloads"), { recursive: true });
        const latest = join(ROOT, "outputs", this.meta.id, "latest");
        ensureLatestSymlink(latest, basename(this.runDir));
        this.logFile = join(this.runDir, "run.log");
        const header = `browser-test ${VERSION}\nTest: ${this.meta.id} ${this.meta.title || ""}\nSession: ${this.session}\nLog level: ${this.logLevel}\n\n`;
        if (this.persistLog) writeFileSync(this.logFile, header);
        else this.logBuffer = header;
    }

    runShell(code, vars) {
        const script = [
            "set -euo pipefail",
            buildShellEnv(vars),
            code,
        ].join("\n");
        const res = spawnSync("bash", ["-c", script], {
            cwd: ROOT,
            encoding: "utf8",
            timeout: this.timeoutMs,
            maxBuffer: 20 * 1024 * 1024,
        });
        const out = `${res.stdout || ""}${res.stderr || ""}`;
        this.appendLog(`\n${code}\n`);
        if (out) this.appendLog(out);
        if (this.opts.verbose && out) process.stdout.write(out);
        if (res.error || res.status !== 0) {
            throw new Error(this.spawnErrorMessage(res, out));
        }
    }

    captureSnapshot() {
        const res = this.ab(["snapshot", "-i"], { allowFail: true });
        return res.output || "";
    }

    captureDiff() {
        const res = this.ab(["diff", "snapshot"], { allowFail: true });
        return res.output || "";
    }

    snapshot(file) {
        writeFileSync(join(this.runDir, file), this.captureSnapshot());
    }

    diff(file) {
        writeFileSync(join(this.runDir, file), this.captureDiff());
    }

    applySettings() {
        if (this.meta.viewport) {
            const [w, h] = String(this.meta.viewport).split("x");
            if (w && h) this.ab(["set", "viewport", w, h], { allowFail: true });
        }
        if (this.meta.device) this.ab(["set", "device", String(this.meta.device)], { allowFail: true });
        if (this.meta.color_scheme) this.ab(["set", "media", String(this.meta.color_scheme)], { allowFail: true });
    }

    run() {
        let vars = {};
        try { vars = this.vars(); } catch { vars = {}; }
        this.logLevel = this.resolveLogLevel(vars);
        this.persistLog = this.logLevel !== "minimal";
        this.snapshotEveryStep = this.logLevel === "verbose";

        this.setup();
        const started = Date.now();
        try {
            vars = this.vars();
            this.ab(["close"], { allowFail: true });
            this.ab(["errors", "--clear"], { allowFail: true });
            if (this.profiler) this.ab(["profiler", "start"], { allowFail: true });
            this.applySettings();

            if (this.meta.state) {
                const statePath = resolve(ROOT, String(this.meta.state));
                if (!existsSync(statePath)) throw new Error(`State file not found: ${this.meta.state}`);
                this.ab(["open", "about:blank"], { allowFail: true });
                // Auth is setup, not a soft step: a missing/expired/invalid state
                // must surface as auth_env (blocked), never run unauthenticated.
                const stateLoad = this.ab(["state", "load", String(statePath)], { allowFail: true });
                if (stateLoad.error || stateLoad.status !== 0) {
                    throw new Error(`could not load auth state ${this.meta.state} (expired or invalid) — re-establish login; do not run unauthenticated`);
                }
            }

            for (let i = 0; i < this.tc.steps.length; i++) {
                const step = this.tc.steps[i];
                const record = { step: i + 1, name: step.name, status: "pass", duration_ms: 0 };
                const t0 = Date.now();
                if (!this.opts.ci) console.log(`▶ Step ${i + 1}: ${step.name}`);
                let beforeBuf = "";
                try {
                    if (!step.code) throw new Error("Step has no bash command block");
                    if (!this.opts.noDiff) {
                        if (this.snapshotEveryStep) this.snapshot(`step${i + 1}-before.txt`);
                        else beforeBuf = this.captureSnapshot();
                    }
                    this.runShell(step.code, vars);
                    if (!this.opts.noDiff && this.snapshotEveryStep) {
                        this.diff(`step${i + 1}-diff.txt`);
                        this.snapshot(`step${i + 1}-after.txt`);
                    }
                } catch (err) {
                    record.status = "fail";
                    record.error = cleanText(err.message || err);
                    this.failed = { step: i + 1, name: step.name, error: record.error };
                    if (!this.opts.noDiff && !this.snapshotEveryStep) {
                        try { writeFileSync(join(this.runDir, `step${i + 1}-before.txt`), beforeBuf); } catch { }
                        try { this.snapshot(`step${i + 1}-after.txt`); } catch { }
                        try { this.diff(`step${i + 1}-diff.txt`); } catch { }
                    }
                    this.flushBufferedLog();
                    throw err;
                } finally {
                    record.duration_ms = Date.now() - t0;
                    this.steps.push(record);
                }
            }
            this.finalChecks();
        } catch (err) {
            if (!this.failed) this.failed = { step: 0, name: "Runtime", error: cleanText(err.message || err) };
            this.flushBufferedLog();
            if (!this.opts.ci) console.error(`FAIL: ${cleanText(err.message || err)}`);
        } finally {
            this.finish(Date.now() - started);
        }
        return this.failed ? 1 : 0;
    }

    finalChecks() {
        if (this.meta.expect?.url) {
            const res = this.ab(["get", "url"]);
            const url = res.stdout.trim();
            this.finalUrl = url; // recorded into result.json for route-level coverage
            if (!globMatch(String(this.meta.expect.url), url)) {
                throw new Error(`Final URL mismatch. expected=${this.meta.expect.url} actual=${url}`);
            }
        }
        if (this.meta.expect?.text) {
            // wait --text just checks the text is present; find text would click
            // it (its default action) and fail on non-interactive text. Word the
            // failure as an assertion so it classifies as assertion_drift.
            const res = this.ab(["wait", "--text", String(this.meta.expect.text)], { allowFail: true });
            if (res.error || res.status !== 0) {
                throw new Error(`Final text assertion failed: page did not contain expected text "${this.meta.expect.text}"`);
            }
        }
    }

    writeHealBrief(stepDef, triage) {
        // A reviewable brief, not an auto-rewrite. Gives the agent everything
        // needed to re-resolve the failed step from its intent.
        let liveSnapshot = "";
        try { liveSnapshot = this.captureSnapshot(); } catch { }
        const lines = [
            `# Heal brief — ${this.meta.id} step ${this.failed.step}: ${this.failed.name}`,
            "",
            `**Failure class:** ${triage.class}`,
            `**Hint:** ${triage.hint}`,
            "",
            `**Step intent (source of truth):** ${stepDef?.intent || "(none recorded — add an 'intent:' line so this step can self-heal)"}`,
            `**Step expectation:** ${stepDef?.expect || "(none)"}`,
            "",
            "**Cached commands that failed (the locator cache to re-resolve):**",
            "```bash",
            (stepDef?.code || "").trim(),
            "```",
            "",
            `**Error:** ${this.failed.error}`,
            "",
            "**Live interactive snapshot (re-resolve the intent against this):**",
            "```",
            liveSnapshot.trim() || "(snapshot unavailable)",
            "```",
            "",
            "**To heal:** pick the element that matches the intent above, update the",
            "step's resolved commands, then re-run `validate` + `run`. Show the diff",
            "for review — never rewrite silently.",
            "",
        ];
        try { writeFileSync(join(this.runDir, "heal-brief.md"), lines.join("\n")); } catch { }
    }

    finish(durationMs) {
        this.ab(["screenshot", "--full", join(this.runDir, "final.png")], { allowFail: true });
        this.ab(["screenshot", "--annotate", join(this.runDir, "final-annotated.png")], { allowFail: true });
        const errors = this.ab(["errors"], { allowFail: true });
        const consoleErrors = errors.output || "";
        writeFileSync(join(this.runDir, "console-errors.log"), consoleErrors);
        // `errors` captures uncaught exceptions only; `console` carries log/warn/
        // error messages (e.g. a 5xx or failed fetch logged via console.error).
        // Keep both so app_bug classification doesn't miss console-level signals.
        const consoleMsgs = this.ab(["console"], { allowFail: true }).output || "";
        writeFileSync(join(this.runDir, "console.log"), consoleMsgs);
        if (this.profiler) this.ab(["profiler", "stop", join(this.runDir, "profile.json")], { allowFail: true });
        if (this.failed) {
            const stepDef = this.tc.steps[this.failed.step - 1];
            const triage = classifyError(this.failed.error, `${consoleErrors}\n${consoleMsgs}`);
            this.failed.class = triage.class;
            this.failed.hint = triage.hint;
            this.failed.intent = stepDef?.intent || "";
            this.writeHealBrief(stepDef, triage);
        }
        if (!this.opts.noTeardown) this.ab(["close"], { allowFail: true });
        const result = {
            schema_version: 2,
            runner_version: VERSION,
            contract_version: CONTRACT_VERSION,
            tc_id: this.meta.id,
            title: this.meta.title || "",
            file: this.opts.file,
            source_sha: fileSha(resolve(ROOT, this.opts.file)),
            final_url: this.finalUrl ?? null,
            session: this.session,
            status: this.failed ? "fail" : "pass",
            failed: this.failed,
            steps: this.steps,
            duration_ms: durationMs,
            artifacts: this.runDir,
            timestamp: new Date().toISOString(),
        };
        writeJson(join(this.runDir, "result.json"), result);
        if (this.opts.report) writeJson(resolve(ROOT, this.opts.report), result);
        writeFileSync(join(this.runDir, "summary.md"), summary(result));
        this.result = result;
        appendHistory({
            ts: result.timestamp,
            tc_id: result.tc_id,
            status: result.status,
            duration_ms: durationMs,
            class: this.failed?.class || null,
            step: this.failed?.step || null,
            commit: gitCommit(),
            runner_version: VERSION,
        });
        if (!this.opts.ci) {
            console.log(`${result.status.toUpperCase()} ${this.meta.id} (${durationMs}ms)`);
            console.log(`Artifacts: ${this.runDir}`);
        }
    }
}

// Tiny glob→regex for expect.url: ** spans path segments, * stays within one.
// Anchored to a full match. Not a general glob engine (no ?, {}, [] support).
function globMatch(pattern, value) {
    let regex = "";
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "*" && pattern[i + 1] === "*") { regex += ".*"; i++; }
        else if (ch === "*") regex += "[^/]*";
        else if (/[?.+^${}()|[\]\\]/.test(ch)) regex += `\\${ch}`;
        else regex += ch;
    }
    return new RegExp(`^${regex}$`).test(value);
}

function summary(result) {
    if (result.status === "pass") return `# ${result.tc_id} PASS\n\nArtifacts: ${result.artifacts}\n`;
    const f = result.failed || {};
    const parts = [
        `# ${result.tc_id} FAIL`,
        "",
        `Step: ${f.step} ${f.name}`,
        `Class: ${f.class || "unknown"}`,
        f.intent ? `Intent: ${f.intent}` : "",
        "",
        `Reason: ${f.error}`,
        "",
        f.hint ? `Next: ${f.hint}` : "",
        f.class === "selector_drift" || f.class === "unknown"
            ? `Heal: read heal-brief.md, or run ./browser-test heal ${result.file} ${f.step}`
            : "",
        "",
        `Artifacts: ${result.artifacts}`,
        "",
    ].filter((l) => l !== "");
    return parts.join("\n") + "\n";
}

// --- static validator ---

const WEAK_GREP = /\bgrep\s+-q[A-Za-z]*\s+(?:\.(?=\s|$|\||;)|["']\.?["'])/;
const BASH_SLEEP = /(?:^|[;&|]|\s)(?:\/(?:usr\/)?bin\/)?sleep\s+[\d.]+|\bpython3?\s+-c\s+["'][^"']*time\.sleep|\bnode\s+-e\s+["'][^"']*setTimeout|\bread\s+-t\s+\d/;
const WAIT_MS = /agent-browser\s+(?:--session\s+\S+\s+)?wait\s+\d+\b/;
const DISABLE_STRICT = /(?:^|[;&|]\s*|\s)set\s+\+e\b|set\s+\+o\s+(?:errexit|pipefail)\b/;
const SWALLOW_EXIT = /\|\|\s*(?:true|:|\/(?:usr\/)?bin\/true)\b/;
const TRAP_ERR = /\btrap\b[^\n]*\bERR\b/;
const TAUTOLOGY_GLOB = /^\*{1,2}(?:\/\*{1,2})*$/; // "*", "**", "**/**", ...
const HARDCODED_URL = /https?:\/\/[^\s"'`)$]+/g;
const URL_ALLOWLIST = /(?:agent-browser\.dev|github\.com\/vercel-labs\/agent-browser|localhost|127\.0\.0\.1|example\.(?:com|org|net))/;
const HARDCODED_CRED = /\b(password|passwd|pwd|token|api[_-]?key|secret|access[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9_\-./]{6,}/i;
// ISO date, or a month name adjacent to a day/year number. Requiring an adjacent
// number avoids flagging ordinary prose like "you may continue".
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const HARDCODED_DATE = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b(?:${MONTHS})\\b[ ,]+\\d{1,4}\\b|\\b\\d{1,2}[ ,]+(?:${MONTHS})\\b`, "i");

function v(rule, label, message, fix) { return { rule, label, message, fix }; }

function collectValidation(tc, file) {
    const errors = [];
    const warnings = [];
    const name = basename(file);
    const n = name.match(/^(\d{3})_/)?.[1];
    const frontmatter = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] || "";

    if (!/^\d{3}_[a-z][a-z0-9_]*\.md$/.test(name)) {
        errors.push(v("filename", "frontmatter",
            "filename must be NNN_<module>.md",
            "rename to e.g. 001_login.md"));
    }
    if (n && tc.meta.id !== `TC-${n}`) {
        errors.push(v("id_mismatch", "frontmatter",
            `id must be TC-${n}`,
            `set frontmatter: id: TC-${n}`));
    }
    if (name.replace(/\.md$/, "") !== tc.meta.session) {
        errors.push(v("session_mismatch", "frontmatter",
            "session must match filename without .md",
            `set frontmatter: session: ${name.replace(/\.md$/, "")}`));
    }
    for (const key of ["id", "title", "module", "session", "env", "state", "techniques", "expect"]) {
        if (!(key in tc.meta)) {
            errors.push(v("frontmatter_missing", "frontmatter",
                `missing field: ${key}`,
                `add: ${key}: <value>`));
        }
    }
    if (Array.isArray(tc.meta.techniques)) {
        for (const t of tc.meta.techniques) {
            if (!ALLOWED_TECHNIQUES.has(String(t))) {
                // Agent judgment, not a safety rule: warn, don't fail.
                warnings.push(v("technique_enum", "frontmatter",
                    `unrecognized technique: ${t}`,
                    `known values: ${[...ALLOWED_TECHNIQUES].join(", ")} (add yours if it's a real agent-browser capability)`));
            }
        }
    }
    if (tc.meta.data && !existsSync(resolve(ROOT, String(tc.meta.data)))) {
        errors.push(v("data_missing", "frontmatter",
            `data file not found: ${tc.meta.data}`,
            "create the file or remove the data field"));
    }
    if (/^(password|passwd|pwd|token|api[_-]?key|secret|access[_-]?token|auth[_-]?token|bearer)\s*:\s*(?!null|""|'')\S+/im.test(frontmatter)) {
        errors.push(v("secret_in_frontmatter", "frontmatter",
            "frontmatter must not contain secrets",
            "move to env/env.local.yaml or use agent-browser auth"));
    }
    if ("expect" in tc.meta && tc.meta.expect !== null && (typeof tc.meta.expect !== "object" || Array.isArray(tc.meta.expect))) {
        errors.push(v("expect_malformed", "frontmatter",
            "expect must be a mapping with url:/text: (or null) — it parsed to a non-object, so final checks would be silently skipped",
            "fix indentation: two-space nested 'url:' and 'text:' under 'expect:'"));
    }
    if (tc.meta.expect && typeof tc.meta.expect === "object") {
        const u = tc.meta.expect.url;
        if (typeof u === "string" && TAUTOLOGY_GLOB.test(u.trim())) {
            errors.push(v("expect_tautology", "frontmatter",
                `expect.url "${u}" matches any page — it asserts nothing`,
                "use a specific glob like \"**/dashboard\" or set url: null and assert per step"));
        }
        if (u === "") {
            errors.push(v("expect_tautology", "frontmatter",
                "expect.url is an empty string (matches/enchecks nothing)",
                "set a real URL glob or url: null"));
        }
    }
    if (tc.meta.log_level && !LOG_LEVELS.has(String(tc.meta.log_level))) {
        errors.push(v("log_level_enum", "frontmatter",
            `log_level must be minimal|normal|verbose, got: ${tc.meta.log_level}`,
            "fix log_level value"));
    }
    for (const step of tc.steps) {
        const label = step.name;
        if (!step.code) {
            errors.push(v("no_bash", label,
                "step has no bash block",
                "add a fenced ```bash ... ``` block"));
            continue;
        }
        if (!step.intent) {
            // Advisory: intent is what lets a step self-heal. Not a hard rule —
            // legacy steps still run — but strongly encouraged.
            warnings.push(v("no_intent", label,
                "step has no 'intent:' line, so it cannot self-heal from intent",
                "add '- intent: <what this step achieves, semantically>' before the bash block"));
        }
        // Accept both --session and the -s short flag.
        if (!/agent-browser\s+(?:--session|-s)\s+(?:"\$SESSION"|\$SESSION)/.test(step.code)) {
            errors.push(v("no_session", label,
                "must use agent-browser --session \"$SESSION\" (or -s \"$SESSION\")",
                "prefix every agent-browser call with --session \"$SESSION\""));
        }
        if (!/(grep|agent-browser\s+(?:--session|-s)\s+(?:"\$SESSION"|\$SESSION)\s+(?:is|find|get|wait))/.test(step.code)) {
            errors.push(v("no_assertion", label,
                "step lacks an assertion / wait",
                "add wait --text/--url/--load, find, is visible, or grep on expected value"));
        }
        if (WEAK_GREP.test(step.code)) {
            errors.push(v("weak_grep", label,
                "grep -q . / \"\" always passes",
                'use wait --text "<expected>", wait --url "**/path", or grep on a real substring'));
        }
        // `get` on its own succeeds no matter what the page says, so a step whose
        // only signal is an unchecked `get` asserts nothing — require a real check.
        {
            const hasGet = /agent-browser\s+(?:--session|-s)\s+(?:"\$SESSION"|\$SESSION)\s+get\b/.test(step.code);
            const hasRealCheck = /(grep|wait\s+--|find\s+(?:role|text|label|placeholder|testid)|\bis\b|\|\||&&|exit\s+1)/.test(step.code);
            if (hasGet && !hasRealCheck) {
                errors.push(v("weak_assertion", label,
                    "`get` is used but its output is never checked — the step asserts nothing",
                    "pipe to grep on an expected value, or use wait --text/--url, or `|| { echo FAIL; exit 1; }`"));
            }
        }
        for (const raw of step.code.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith("#")) continue;
            const codePart = line.split("#")[0];
            // The runner trusts the step's exit code; these constructs let a
            // failed command still report success, so they're hard errors.
            if (DISABLE_STRICT.test(codePart)) {
                errors.push(v("disable_strict", label,
                    "disabling strict mode (set +e / set +o errexit|pipefail) lets failures pass as success",
                    "remove it; rely on the runner's 'set -euo pipefail' and assert explicitly"));
            }
            if (SWALLOW_EXIT.test(codePart)) {
                errors.push(v("swallow_exit", label,
                    "'|| true' / '|| :' swallows a failing command — the step can never fail",
                    "use '|| { echo \"FAIL: <reason>\"; exit 1; }' to fail loudly, or drop the guard"));
            }
            if (TRAP_ERR.test(codePart)) {
                errors.push(v("trap_err", label,
                    "trapping ERR can suppress failures",
                    "remove the ERR trap; let the runner detect non-zero exit"));
            }
            if (BASH_SLEEP.test(codePart)) {
                errors.push(v("bash_sleep", label,
                    "bash 'sleep N' is forbidden",
                    "use agent-browser wait --text/--url/--load/--fn or wait @ref"));
            }
            if (WAIT_MS.test(codePart) && !line.includes("#")) {
                errors.push(v("bare_wait", label,
                    "bare 'wait <ms>' without inline '# reason' comment",
                    "use signal-based wait (--text/--url/--load/--fn) or add inline '# <reason>'"));
            }
            for (const m of codePart.matchAll(HARDCODED_URL)) {
                const url = m[0].replace(/[),;]+$/, "");
                if (!url.includes("$") && !URL_ALLOWLIST.test(url)) {
                    errors.push(v("hardcoded_url", label,
                        `hard-coded URL: ${url}`,
                        "use $base_url or shell var sourced from env/data"));
                }
            }
            if (HARDCODED_CRED.test(codePart)) {
                errors.push(v("hardcoded_cred", label,
                    "hard-coded credential / token literal",
                    "move to env/env.local.yaml; reference as $USERNAME / $PASSWORD"));
            }
            if (HARDCODED_DATE.test(codePart)) {
                warnings.push(v("hardcoded_date", label,
                    "hard-coded date / month — likely to break later",
                    "compute via $(date ...) or assert format/regex only"));
            }
        }
    }
    // Cross-step checks (require all steps to be collected first)
    const allCode = tc.steps.map((s) => s.code).join("\n");

    // Embedded signup/login in a non-auth module → should use state: instead
    if (!["login", "signup", "auth", "register"].includes(String(tc.meta.module))) {
        if (/data-qa="signup-button"|ACCOUNT CREATED|ENTER ACCOUNT INFORMATION|signup-email/.test(allCode)) {
            warnings.push(v("embedded_auth_flow", "steps",
                "signup/login sequence found in a non-auth module — embed auth as state: frontmatter instead",
                "save auth once: agent-browser --session <s> state save state/<user>.auth.json, then set state: state/<user>.auth.json in frontmatter"));
        }
    }

    // eval with positional DOM indexing — silent breakage when DOM changes
    if (tc.steps.some((s) =>
        /\beval\b/.test(s.code) &&
        /query(?:Selector|SelectorAll)\s*\([^)]*\)\s*\[\d+\]/.test(s.code.replace(/\n/g, " ")))) {
        warnings.push(v("eval_positional_query", "steps",
            "eval uses positional querySelectorAll indexing (els[0], els[1]…) — breaks silently when DOM changes",
            "use find first '[data-qa=\"field\"]' fill \"$value\"; run ./browser-test discover <url> to list available attributes"));
    }

    // Repeated network route --abort across multiple steps (routes persist in session)
    const stepsWithRoutes = tc.steps.filter((s) =>
        /agent-browser\s+(?:--session|-s)\s+\S+\s+network\s+route/.test(s.code));
    if (stepsWithRoutes.length > 1) {
        warnings.push(v("repeated_network_routes", "steps",
            `network route --abort appears in ${stepsWithRoutes.length} steps — routes persist for the whole session`,
            "move all network route --abort calls to the first step that opens the URL; later steps inherit them"));
    }

    return { errors, warnings };
}

function validate(tc, file) {
    const { errors, warnings } = collectValidation(tc, file);
    for (const w of warnings) console.warn(`! warn[${w.rule}] ${w.label}: ${w.message}\n  -> fix: ${w.fix}`);
    if (errors.length) {
        for (const e of errors) console.error(`- err[${e.rule}] ${e.label}: ${e.message}\n  -> fix: ${e.fix}`);
        return 1;
    }
    console.log(`OK ${basename(file)}${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`);
    return 0;
}

// --- flake intelligence ---

const HISTORY_MAX = 5000;        // cap on retained history records
let currentCommit; // memoized
function gitCommit() {
    if (currentCommit !== undefined) return currentCommit;
    try {
        const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
        currentCommit = (!r.error && r.status === 0) ? r.stdout.trim() : null;
    } catch { currentCommit = null; }
    return currentCommit;
}

// Cross-process file lock via O_EXCL; reclaims a stale lock (>10s old, from a
// crashed writer). Returns a release fn, or null if it couldn't acquire.
function acquireLock(lockPath, tries = 50) {
    for (let i = 0; i < tries; i++) {
        try {
            const fd = openSync(lockPath, "wx");
            writeSync(fd, String(process.pid));
            closeSync(fd);
            return () => { try { unlinkSync(lockPath); } catch { } };
        } catch (e) {
            if (e.code !== "EEXIST") return null;
            try { if (Date.now() - statSync(lockPath).mtimeMs > 10000) { unlinkSync(lockPath); continue; } } catch { }
            // brief spin without async; telemetry is not hot-path
            const until = Date.now() + 20; while (Date.now() < until) { /* spin */ }
        }
    }
    return null;
}

function appendHistory(record) {
    try {
        const f = HISTORY_FILE();
        mkdirSync(dirname(f), { recursive: true });
        // O_APPEND write of a single small line is atomic across processes.
        appendFileSync(f, `${JSON.stringify(record)}\n`);
        // Rotation is read-modify-write, which races the append above. Guard it
        // with a lock and replace via atomic rename so concurrent CI shards
        // never truncate each other's records. Only one process rotates.
        if (statSync(f).size > HISTORY_MAX * 220) {
            const release = acquireLock(`${f}.lock`);
            if (release) {
                try {
                    const lines = readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
                    if (lines.length > HISTORY_MAX) {
                        const tmp = `${f}.${process.pid}.tmp`;
                        writeFileSync(tmp, lines.slice(-HISTORY_MAX).join("\n") + "\n");
                        renameSync(tmp, f); // atomic replace
                    }
                } finally { release(); }
            }
        }
    } catch { /* telemetry must never break a run */ }
}

function readHistory() {
    const f = HISTORY_FILE();
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
}

const FLAKE_MIN_RUNS = 5;
const QUARANTINABLE_CLASSES = new Set(["timing", "selector_drift"]); // test-side, safe to quarantine

function indexHistory(records) {
    const byTc = new Map();
    for (const r of records) {
        if (!r.tc_id) continue;
        let arr = byTc.get(r.tc_id);
        if (!arr) byTc.set(r.tc_id, (arr = []));
        arr.push(r);
    }
    return byTc;
}

// Score one flow's flakiness from its own run slice; narrows the window to the
// latest commit once there's enough data, so pre-fix failures don't taint it.
function flakeStats(runsForTc, tcId) {
    let all = runsForTc || [];
    const latestCommit = all.length ? all[all.length - 1].commit : undefined;
    if (latestCommit) {
        const scoped = all.filter((r) => r.commit === latestCommit);
        if (scoped.length >= FLAKE_MIN_RUNS) all = scoped; // only narrow if enough data
    }
    const runs = all.slice(-FLAKE_WINDOW);
    const n = runs.length;
    if (n === 0) return { tc_id: tcId, runs: 0, pass: 0, fail: 0, passRate: null, flakeScore: 0, flaky: false, intermittent: false, classes: {} };
    let pass = 0, fail = 0, transitions = 0;
    const classes = {};
    for (let i = 0; i < n; i++) {
        const ok = runs[i].status === "pass";
        if (ok) pass++; else { fail++; const c = runs[i].class || "unknown"; classes[c] = (classes[c] || 0) + 1; }
        if (i > 0 && (runs[i].status === "pass") !== (runs[i - 1].status === "pass")) transitions++;
    }
    const flakeScore = n > 1 ? transitions / (n - 1) : 0;
    const oscillating = n >= FLAKE_MIN_RUNS && flakeScore >= FLAKE_THRESHOLD && pass > 0 && fail > 0;
    const failClasses = Object.keys(classes);
    const allEnvFails = failClasses.length > 0 && failClasses.every((c) => QUARANTINABLE_CLASSES.has(c));
    const flaky = oscillating && allEnvFails;
    const intermittent = oscillating && !allEnvFails;
    return { tc_id: tcId, runs: n, pass, fail, passRate: pass / n, flakeScore, flaky, intermittent, classes };
}

const DEFAULT_QUARANTINE_DAYS = 14;

function quarantineEntries() {
    const f = QUARANTINE_FILE();
    if (!existsSync(f)) return [];
    try {
        const j = JSON.parse(readFileSync(f, "utf8"));
        const raw = Array.isArray(j) ? j : (j.entries || j.quarantined || []);
        return raw.map((e) => typeof e === "string"
            ? { id: e, reason: "", added: null, expires: null, commit: null }
            : { id: e.id, reason: e.reason || "", added: e.added || null, expires: e.expires || null, commit: e.commit || null })
            .filter((e) => e.id);
    } catch { return []; }
}

function isExpired(entry, now = Date.now()) {
    return entry.expires != null && Date.parse(entry.expires) <= now;
}

function loadQuarantine() {
    const now = Date.now();
    return quarantineEntries().filter((e) => !isExpired(e, now)).map((e) => e.id);
}

function saveQuarantineEntries(entries) {
    const seen = new Map();
    for (const e of entries) seen.set(e.id, e); // last wins
    const list = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
    writeJson(QUARANTINE_FILE(), {
        entries: list,
        note: "Tracked policy: flows skipped by the gate until healed. Each entry has a reason + expiry so nothing is hidden forever. Edit via ./browser-test quarantine.",
    });
    return list;
}

function quarantineCommand(argv) {
    const args = argv.slice(3);
    const pos = args.filter((a) => !a.startsWith("-"));
    const action = pos[0] || "list";
    const id = pos[1];
    const reasonIdx = args.indexOf("--reason");
    const reason = reasonIdx >= 0 ? (args[reasonIdx + 1] || "") : "";
    const daysIdx = args.indexOf("--days");
    const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : DEFAULT_QUARANTINE_DAYS;
    const entries = quarantineEntries();

    if (action === "list") {
        if (!entries.length) { console.log("quarantine: empty"); return 0; }
        const now = Date.now();
        console.log(`${"ID".padEnd(9)} ${"EXPIRES".padEnd(12)} REASON`);
        for (const e of entries.sort((a, b) => a.id.localeCompare(b.id))) {
            const exp = e.expires ? e.expires.slice(0, 10) : "never";
            const tag = isExpired(e, now) ? " [EXPIRED → back on gate]" : "";
            console.log(`${e.id.padEnd(9)} ${exp.padEnd(12)} ${e.reason || "(no reason given)"}${tag}`);
        }
        return 0;
    }
    if (action === "add") {
        if (!id) { console.error('usage: browser-test quarantine add <TC-ID> [--reason "why"] [--days N]'); return 1; }
        if (!reason) console.warn("WARN: no --reason given; quarantine entries should record why (audit trail).");
        if (Number.isNaN(days) || days < 0) { console.error("--days must be a non-negative number (0 = no expiry)"); return 1; }
        const expires = days === 0 ? null : new Date(Date.now() + days * 86400000).toISOString();
        if (days === 0) console.warn("WARN: --days 0 means NO expiry — this can hide a failure indefinitely. Prefer a finite window.");
        const next = entries.filter((e) => e.id !== id);
        next.push({ id, reason, added: new Date().toISOString(), expires, commit: gitCommit() });
        saveQuarantineEntries(next);
        console.log(`Quarantined ${id}${expires ? ` until ${expires.slice(0, 10)}` : " (no expiry)"}${reason ? ` — ${reason}` : ""}.`);
        return 0;
    }
    if (action === "remove") {
        if (!id) { console.error("usage: browser-test quarantine remove <TC-ID>"); return 1; }
        saveQuarantineEntries(entries.filter((e) => e.id !== id));
        console.log(`Released ${id}.`);
        return 0;
    }
    console.error('usage: browser-test quarantine [list | add <TC-ID> [--reason "why"] [--days N] | remove <TC-ID>]');
    return 1;
}

function flakyCommand() {
    const records = readHistory();
    if (!records.length) { console.log("no run history yet (run some flows first)"); return 0; }
    const byTc = indexHistory(records);
    const ids = [...byTc.keys()].sort();
    const quarantined = new Set(loadQuarantine());
    console.log(`${"FLAKE".padEnd(6)} ${"PASS%".padEnd(6)} ${"RUNS".padEnd(5)} ${"ID".padEnd(8)} CLASSES / STATUS`);
    const recommend = [];
    const investigate = [];
    for (const id of ids) {
        const s = flakeStats(byTc.get(id), id);
        const flakePct = `${Math.round(s.flakeScore * 100)}%`;
        const passPct = s.passRate == null ? "—" : `${Math.round(s.passRate * 100)}%`;
        const cls = Object.entries(s.classes).map(([k, v]) => `${k}:${v}`).join(" ") || "—";
        const tag = quarantined.has(id) ? "[quarantined]"
            : s.flaky ? "[FLAKY]"
            : s.intermittent ? "[INTERMITTENT]"
            : "";
        console.log(`${flakePct.padEnd(6)} ${passPct.padEnd(6)} ${String(s.runs).padEnd(5)} ${id.padEnd(8)} ${cls} ${tag}`);
        if (s.flaky && !quarantined.has(id)) recommend.push(id);
        if (s.intermittent && !quarantined.has(id)) investigate.push(id);
    }
    if (recommend.length) {
        console.log(`\nFlaky (env-class oscillation) — quarantine while you heal the wait/selector:`);
        for (const id of recommend) console.log(`  ./browser-test quarantine add ${id}`);
    }
    if (investigate.length) {
        console.log(`\nINTERMITTENT — oscillates with app_bug/assertion/unknown failures. Likely a REAL`);
        console.log(`intermittent defect, NOT a flaky test. Investigate; do not quarantine to hide it:`);
        for (const id of investigate) console.log(`  ${id}`);
    }
    return 0;
}

// --- list / history ---

function readLastResult(tcId) {
    if (!tcId) return null;
    const latestLink = resolve(ROOT, "outputs", tcId, "latest");
    if (!existsSync(latestLink)) return null;
    try {
        const resultFile = join(latestLink, "result.json");
        if (!existsSync(resultFile)) return null;
        return JSON.parse(readFileSync(resultFile, "utf8"));
    } catch { return null; }
}

function listCommand(opts = {}) {
    const testsDir = resolve(ROOT, "tests");
    if (!existsSync(testsDir)) { console.log("no tests/ directory"); return 0; }
    const files = readdirSync(testsDir).filter(isTestFile).sort();
    if (!files.length) { console.log("no testcases under tests/"); return 0; }
    console.log(`${"STATUS".padEnd(10)} ${"ID".padEnd(8)} ${"MODULE".padEnd(12)} TITLE  (file)`);
    let notPassing = 0;
    for (const f of files) {
        try {
            const md = readFileSync(join(testsDir, f), "utf8");
            const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
            const meta = parseSimpleYaml(fm);
            const last = readLastResult(meta.id);
            const curSha = fileSha(join(testsDir, f));
            let status;
            if (!last) status = "UNVERIFIED";                      // authored, never run
            else if (last.status === "pass" && last.source_sha && curSha && last.source_sha !== curSha)
                status = "STALE";                                  // passed, but the file changed since
            else status = last.status;
            if (status !== "pass") notPassing++;
            console.log(`${String(status).padEnd(10)} ${String(meta.id || "—").padEnd(8)} ${String(meta.module || "—").padEnd(12)} ${meta.title || ""}  (${f})`);
        } catch (err) {
            notPassing++;
            console.log(`${"ERROR".padEnd(10)} ${f}: ${err.message}`);
        }
    }
    if (notPassing) {
        console.log(`\n${notPassing} testcase(s) are UNVERIFIED / STALE / failing (no passing run of the current version).`);
        if (opts.strict) {
            console.error("strict: a testcase without a passing run is not done. Run it (./browser-test run) before trusting it.");
            return 1;
        }
        console.log("Run them — a testcase that was never executed proves nothing. (use 'list --strict' to gate this in CI.)");
    }
    return 0;
}

function historyCommand(tcId) {
    const records = readHistory();
    if (records.length) {
        const byTc = indexHistory(records);
        const ids = tcId ? [tcId] : [...byTc.keys()].sort();
        for (const id of ids) {
            const tcRuns = byTc.get(id) || [];
            const runs = tcRuns.slice(-10);
            if (!runs.length) { console.log(`${id}: no runs`); continue; }
            const s = flakeStats(tcRuns, id);
            const flag = s.flaky ? "  [FLAKY]" : "";
            console.log(`\n${id}  pass ${Math.round((s.passRate || 0) * 100)}%  flake ${Math.round(s.flakeScore * 100)}%${flag}`);
            for (const r of runs) {
                const status = String(r.status || "?").padEnd(5);
                const dur = String(r.duration_ms || 0).padStart(6);
                const cls = r.class ? `  ${r.class}${r.step ? ` @step${r.step}` : ""}` : "";
                console.log(`  ${status} ${dur}ms  ${r.ts}${cls}`);
            }
        }
        return 0;
    }
    const outDir = resolve(ROOT, "outputs");
    if (!existsSync(outDir)) { console.log("no outputs/ directory"); return 0; }
    const tcs = tcId
        ? [tcId]
        : readdirSync(outDir)
            .filter(d => /^TC-/.test(d) && statSync(join(outDir, d)).isDirectory())
            .sort();
    if (!tcs.length) { console.log("no runs"); return 0; }
    for (const tc of tcs) {
        const tcPath = join(outDir, tc);
        if (!existsSync(tcPath)) { console.log(`${tc}: no runs`); continue; }
        const runs = readdirSync(tcPath).filter(d => /^\d{4}-/.test(d)).sort().slice(-10);
        if (!runs.length) { console.log(`${tc}: no runs`); continue; }
        console.log(`\n${tc}`);
        for (const r of runs) {
            const resultFile = join(tcPath, r, "result.json");
            if (!existsSync(resultFile)) continue;
            try {
                const j = JSON.parse(readFileSync(resultFile, "utf8"));
                const status = String(j.status || "?").padEnd(5);
                const dur = String(j.duration_ms || 0).padStart(6);
                const tail = j.failed?.error ? `  ${j.failed.error.split("\n")[0].slice(0, 80)}` : "";
                console.log(`  ${status} ${dur}ms  ${r}${tail}`);
            } catch { }
        }
    }
    return 0;
}

// --- heal ---

function healCommand(argv) {
    const positionals = argv.slice(3).filter((a) => !a.startsWith("-"));
    const file = positionals[0];
    const stepArg = positionals[1];
    if (!file) { console.error("usage: browser-test heal <file> <step>"); return 1; }
    const tc = readCase(file);
    const idx = stepArg ? Number(stepArg) - 1 : -1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= tc.steps.length) {
        console.error(`step must be 1..${tc.steps.length}`);
        return 1;
    }
    const step = tc.steps[idx];
    const session = tc.meta.session;
    const snap = spawnSync("agent-browser", ["--session", session, "snapshot", "-i"], {
        cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    });
    const live = `${snap.stdout || ""}${snap.stderr || ""}`.trim();
    const out = [
        `# Heal brief — ${tc.meta.id} step ${idx + 1}: ${step.name}`,
        "",
        `Intent (source of truth): ${step.intent || "(none — add an 'intent:' line first)"}`,
        `Expectation: ${step.expect || "(none)"}`,
        "",
        "Cached commands to re-resolve:",
        "```bash",
        (step.code || "").trim(),
        "```",
        "",
        `Live interactive snapshot (session "${session}" — open the page first if empty):`,
        "```",
        live || "(no live session — run the flow up to this step, then heal)",
        "```",
        "",
        "Re-resolve the intent against the snapshot, patch the step's commands,",
        "then `validate` + `run`. Show the diff for review.",
    ].join("\n");
    console.log(out);
    return 0;
}

// --- coverage ---

function loadCoverageMap() {
    const f = resolve(ROOT, "coverage.map");
    if (!existsSync(f)) return null;
    const features = [];
    for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const [mod, name, route] = line.split("|").map((s) => (s || "").trim());
        if (mod) features.push({ module: mod, name: name || mod, route: route || "" });
    }
    return features;
}

function testInventory() {
    const dir = resolve(ROOT, "tests");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(isTestFile).sort()
        .map((f) => {
            try {
                const tc = readCase(join(dir, f));
                return { file: f, id: tc.meta.id, module: tc.meta.module, expectUrl: tc.meta.expect?.url || null };
            } catch { return { file: f, id: null, module: null, expectUrl: null }; }
        });
}

function coverageCommand() {
    const features = loadCoverageMap();
    const tests = testInventory();
    const byModule = {};
    for (const t of tests) { const m = t.module || "—"; (byModule[m] ||= []).push(t); }

    if (!features) {
        console.log("No coverage.map found. Modules currently covered by tests/:");
        const mods = Object.keys(byModule).filter((m) => m !== "—").sort();
        if (!mods.length) console.log("  (none)");
        for (const m of mods) console.log(`  ${m.padEnd(14)} ${byModule[m].length} test(s)`);
        console.log("\nCreate coverage.map (one feature per line: 'module | Feature name | route')");
        console.log("to get gap analysis — what the app does vs what is tested.");
        return 0;
    }

    // Per-test state, same rule as `list`: a pass on a file that changed since
    // the run (source_sha drift) counts as STALE, not covered. Read result.json
    // (not history.jsonl, which has no source_sha) and grab each test's last
    // final URL so features with a route match by route, not just module.
    const testsDir = resolve(ROOT, "tests");
    const quar = new Set(loadQuarantine());
    const info = new Map(); // id -> { state, finalUrl }
    for (const t of tests) {
        if (!t.id) continue;
        let state, finalUrl = null;
        if (quar.has(t.id)) state = "quarantined";
        else {
            const last = readLastResult(t.id);
            if (!last) state = "unrun";
            else {
                finalUrl = last.final_url || null;
                if (last.status === "pass") {
                    const curSha = fileSha(join(testsDir, t.file));
                    state = (last.source_sha && curSha && last.source_sha !== curSha) ? "stale" : "pass";
                } else state = "fail";
            }
        }
        info.set(t.id, { state, finalUrl });
    }
    const stateOf = (t) => (t.id ? (info.get(t.id)?.state || "unrun") : "unparsable");

    let covered = 0, partial = 0;
    const gaps = [];
    console.log(`${"COV".padEnd(4)} ${"MODULE".padEnd(14)} ${"TESTS".padEnd(6)} FEATURE`);
    for (const feat of features) {
        const moduleHits = byModule[feat.module] || [];
        // If the feature declares a route, a module test counts for THIS feature
        // only when its recorded final URL matches the route glob. Tests with no
        // recorded final URL fall back to module-level inclusion (backward compat).
        const hits = feat.route
            ? moduleHits.filter((t) => { const fu = info.get(t.id)?.finalUrl; return fu ? globMatch(feat.route, fu) : true; })
            : moduleHits;
        const states = hits.map(stateOf);
        const isCovered = states.includes("pass");
        const hasTests = hits.length > 0;
        let mark;
        if (isCovered) { mark = "✓"; covered++; }
        else if (hasTests) { mark = "⚠"; partial++; }
        else { mark = "·"; gaps.push(feat); }
        const detail = hasTests && !isCovered ? `  [${[...new Set(states)].join(",")}]` : "";
        console.log(`${mark.padEnd(4)} ${feat.module.padEnd(14)} ${String(hits.length).padEnd(6)} ${feat.name}${feat.route ? `  (${feat.route})` : ""}${detail}`);
    }
    const pct = features.length ? Math.round((covered / features.length) * 100) : 0;
    console.log(`\nCoverage: ${covered}/${features.length} features passing (${pct}%)`);
    if (partial) console.log(`Partial: ${partial} feature(s) have a test that is failing, never-run, or quarantined — not counted as covered.`);
    if (gaps.length) {
        console.log("Gaps (no test at all):");
        for (const g of gaps) console.log(`  ${g.module} — ${g.name}`);
    }
    const tracked = new Set(features.map((f) => f.module));
    const untracked = Object.keys(byModule).filter((m) => m !== "—" && !tracked.has(m));
    if (untracked.length) {
        console.log(`\nDrift — tested but absent from coverage.map (add them or fix the module name): ${untracked.join(", ")}`);
    }
    return untracked.length ? 2 : 0; // exit 2 on map drift (untracked modules), not on gaps
}

// --- eval: the skill proves itself ---

function evalCommand() {
    let pass = 0, fail = 0;
    const ok = (name) => { pass++; console.log(`  ok   ${name}`); };
    const bad = (name, detail) => { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); };

    // 1. Golden validation cases.
    const manifestPath = resolve(ROOT, "eval/golden/manifest.json");
    if (existsSync(manifestPath)) {
        let manifest = { good: [], bad: [] };
        try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { }
        console.log("Golden — good (must validate):");
        for (const rel of manifest.good || []) {
            const file = resolve(ROOT, "eval/golden", rel);
            try {
                const { errors } = collectValidation(readCase(file), file);
                errors.length ? bad(rel, `unexpected errors: ${errors.map((e) => e.rule).join(",")}`) : ok(rel);
            } catch (e) { bad(rel, e.message); }
        }
        console.log("Golden — bad (must trip the target rule):");
        for (const c of manifest.bad || []) {
            const file = resolve(ROOT, "eval/golden", c.file);
            try {
                const { errors } = collectValidation(readCase(file), file);
                errors.some((e) => e.rule === c.rule) ? ok(`${c.file} → ${c.rule}`)
                    : bad(c.file, `expected rule '${c.rule}', got: ${errors.map((e) => e.rule).join(",") || "none"}`);
            } catch (e) { bad(c.file, e.message); }
        }
    } else {
        console.log("(no eval/golden/manifest.json — skipping golden cases)");
    }

    // 2. Failure classifier.
    console.log("Classifier:");
    const classCases = [
        ["could not find element @e7", "selector_drift"],
        ["timed out waiting for selector", "timing"],
        ["Final URL mismatch. expected=**/x actual=/y", "assertion_drift"],
        ["Final text assertion failed: page did not contain expected text \"Saved\"", "assertion_drift"],
        ["State file not found: state/admin.auth.json", "auth_env"],
    ];
    for (const [err, want] of classCases) {
        const got = classifyError(err).class;
        got === want ? ok(`"${err.slice(0, 28)}…" → ${want}`) : bad(`classify`, `"${err}" → ${got}, want ${want}`);
    }

    // Classifier must NOT misread a missing-binary env error as selector drift.
    classifyError("agent-browser: command not found").class !== "selector_drift"
        ? ok(`"command not found" not selector_drift`)
        : bad("classify", "env error misclassified as selector_drift");

    // A per-step timeout (spawnSync ETIMEDOUT) must classify as timing.
    classifyError("spawnSync bash ETIMEDOUT").class === "timing"
        ? ok(`"ETIMEDOUT" → timing`)
        : bad("classify", "ETIMEDOUT not classed as timing");

    // 3. Flake math — the misclassification guards: min-sample, intermittent-vs-flaky, commit scope.
    console.log("Flake math:");
    const mk = (id, statuses, cls = "timing") => statuses.map((s) => ({ tc_id: id, status: s, class: s === "fail" ? cls : null }));
    const fs1 = flakeStats(mk("TC-X", ["pass", "fail", "pass", "fail", "pass", "fail"]), "TC-X");
    fs1.flaky ? ok("env-class oscillation flagged flaky") : bad("flake", `score ${fs1.flakeScore}`);
    const fs2 = flakeStats(mk("TC-Y", ["fail", "fail", "fail", "fail", "fail", "fail"], "selector_drift"), "TC-Y");
    !fs2.flaky ? ok("consistently failing not called flaky") : bad("flake", "all-fail marked flaky");
    const fs3 = flakeStats(mk("TC-Z", ["pass", "fail"]), "TC-Z");
    !fs3.flaky ? ok("sparse history (n=2) not flaky") : bad("flake", "n=2 wrongly flaky");
    const fs4 = flakeStats(mk("TC-W", ["pass", "fail", "pass", "fail", "pass", "fail"], "app_bug"), "TC-W");
    (!fs4.flaky && fs4.intermittent) ? ok("app_bug oscillation → intermittent, not flaky")
        : bad("flake", `flaky=${fs4.flaky} intermittent=${fs4.intermittent}`);

    // JUnit must be XML-safe even with ANSI / control bytes in the error.
    console.log("CI output safety:");
    const dirty = junitXml([{ tc_id: "TC-1", title: "x", status: "fail", duration_ms: 5,
        failed: { class: "timing", step: 1, name: "s", error: "boom \x1B[31mred\x1B[0m \x00\x07 end" } }]);
    !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|\x1B/.test(dirty)
        ? ok("junit XML free of illegal control/ANSI chars")
        : bad("junit", "illegal chars leaked into XML");

    // 5. Quarantine expiry — an expired entry must auto-return to the gate.
    console.log("Quarantine expiry:");
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    isExpired({ expires: past }) ? ok("past-dated quarantine is expired") : bad("expiry", "past not expired");
    !isExpired({ expires: future }) ? ok("future-dated quarantine still active") : bad("expiry", "future marked expired");
    !isExpired({ expires: null }) ? ok("no-expiry entry never auto-expires") : bad("expiry", "null expiry expired");

    // 6. Version consistency — runner VERSION, package.json and SKILL.md must
    // agree. A file can be missing once the skill is copied into a project; only
    // a real mismatch fails, an absent file is fine.
    console.log("Version consistency:");
    const readVer = (p, re) => { try { return readFileSync(resolve(ROOT, p), "utf8").match(re)?.[1]?.trim() || null; } catch { return null; } };
    const pkgVer = readVer("package.json", /"version"\s*:\s*"([^"]+)"/);
    const skillVer = readVer("SKILL.md", /^version:\s*(.+)$/m);
    const skillContract = readVer("SKILL.md", /^contract_version:\s*(.+)$/m);
    pkgVer == null || pkgVer === VERSION ? ok(`package.json matches VERSION (${VERSION})`) : bad("version", `package.json ${pkgVer} != runner ${VERSION}`);
    skillVer == null || skillVer === VERSION ? ok(`SKILL.md matches VERSION (${VERSION})`) : bad("version", `SKILL.md ${skillVer} != runner ${VERSION}`);
    skillContract == null || skillContract === String(CONTRACT_VERSION) ? ok(`SKILL.md matches contract_version (${CONTRACT_VERSION})`) : bad("version", `SKILL.md contract_version ${skillContract} != runner ${CONTRACT_VERSION}`);

    console.log(`\neval: ${pass} passed, ${fail} failed`);
    return fail ? 1 : 0;
}

// --- scaffolder (new) ---

function scaffoldBody(id, module, session, title, { stateFile = null, dataFile = null } = {}) {
    const authHint = stateFile
        ? `\n<!-- Auth: starts authenticated via ${stateFile}.\n` +
          `     Create once: run a login/signup test, then:\n` +
          `     agent-browser --session <session> state save ${stateFile} -->\n`
        : "";
    const dataHint = dataFile
        ? `\n<!-- Data: typed values in ${dataFile}; referenced as $variable_name in bash steps. -->\n`
        : "";
    return `---
id: ${id}
title: "${title.replace(/"/g, "'")}"
module: ${module}
session: ${session}
env: env/env.yaml
state: ${stateFile || "null"}
data: ${dataFile || "null"}
techniques: [semantic_locator, wait_text]
expect:
  url: null                  # final URL glob e.g. "**/dashboard", or null
  text: null                 # final visible text e.g. "Welcome", or null
---

# ${id}: ${title}
${authHint}${dataHint}
## Objective
<one sentence: what behaviour does this verify?>

## Steps

### 1. <imperative step name>
- intent: <semantic goal — source of truth for self-healing>
- expect: <observable signal: text / URL / element>
\`\`\`bash
agent-browser --session "$SESSION" open "$base_url"
agent-browser --session "$SESSION" wait --text "<FILL: stable text you observed>"
# Use durable locators for actions, e.g.:
# agent-browser --session "$SESSION" find role button click --name "<FILL: button name>"
# agent-browser --session "$SESSION" find first '[data-qa="<FILL>"]' click
\`\`\`

<!-- add more steps; each: intent + expect bullets, then a bash block ending in a
     signal-based wait or assertion. Use snapshot -i while exploring and before
     @eN refs; prefer stable test attributes and semantic locators in saved tests.
     Never sleep, never || true. -->
`;
}

async function newCommand(argv) {
    const pos = argv.slice(3).filter((a) => !a.startsWith("-"));
    const module = pos[0];
    const title = pos[1] || `${module} flow`;
    if (!module || !/^[a-z]+$/.test(module)) {
        console.error('usage: browser-test new <module:[a-z]+> ["title"]');
        return 1;
    }
    const testsDir = resolve(ROOT, "tests");
    mkdirSync(testsDir, { recursive: true });
    // Next free TC-NNN across the whole tests/ dir (ids are globally unique).
    let maxN = 0;
    for (const f of readdirSync(testsDir).filter(isTestFile)) {
        const fm = readFileSync(join(testsDir, f), "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
        const m = String(parseSimpleYaml(fm).id || "").match(/TC-(\d+)/);
        if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    const nnn = String(maxN + 1).padStart(3, "0");
    const id = `TC-${nnn}`;
    const session = `${nnn}_${module}`;
    const file = join(testsDir, `${session}.md`);
    if (existsSync(file)) { console.error(`already exists: tests/${session}.md`); return 1; }

    let stateFile = null;
    let dataFile = null;

    if (process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
            const auth = await rl.question(`Does this test need an authenticated user? [y/N] `);
            if (/^y/i.test(auth.trim())) stateFile = `state/${module}_user.auth.json`;
            const data = await rl.question(`Does this test use input data (data/*.yaml)? [y/N] `);
            if (/^y/i.test(data.trim())) dataFile = `data/${module}.yaml`;
        } finally {
            rl.close();
        }
    }

    if (dataFile) {
        const dataPath = resolve(ROOT, dataFile);
        mkdirSync(dirname(dataPath), { recursive: true });
        if (!existsSync(dataPath)) {
            writeFileSync(dataPath, `# Test data for ${module} — keys become $shell_vars in bash steps.\n# example_key: example_value\n`);
            console.log(`Created ${dataFile}`);
        }
    }

    writeFileSync(file, scaffoldBody(id, module, session, title, { stateFile, dataFile }));
    console.log(`\nCreated tests/${session}.md (${id}).`);

    if (stateFile) {
        console.log(`\nAuth setup needed (one-time):`);
        console.log(`  1. Run the login/signup flow once to get an authenticated browser session`);
        console.log(`  2. agent-browser --session <session> state save ${stateFile}`);
        console.log(`  (${stateFile} is gitignored — never committed)`);
    }
    if (dataFile) {
        console.log(`\nFill ${dataFile} with values; reference as $key_name in bash steps.`);
    }
    console.log(`\nExplore live first (snapshot to understand the UI, semantic locators for saved commands):`);
    console.log(`  ./browser-test discover <url>               # list all testable attributes`);
    console.log(`  agent-browser --session ${session} snapshot -i`);
    console.log(`\nThen validate and run:`);
    console.log(`  ./browser-test validate tests/${session}.md && ./browser-test run tests/${session}.md`);
    return 0;
}

function duplicateIds(files) {
    const byId = {};
    for (const f of files) {
        try {
            const fm = readFileSync(f, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
            const id = parseSimpleYaml(fm).id;
            if (id) (byId[id] ||= []).push(basename(f));
        } catch { /* parse errors handled elsewhere */ }
    }
    return Object.fromEntries(Object.entries(byId).filter(([, fs]) => fs.length > 1));
}

// --- parallel execution (-j) ---
function resolveJobs(raw) {
    if (raw == null) return 1;
    if (String(raw).toLowerCase() === "auto") return Math.max(1, cpus().length);
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n >= 1 ? n : 1;
}

function workerArgs(file, opts) {
    const a = ["run", file, "--ci"];
    if (opts.env) a.push("-e", opts.env);
    if (opts.timeout != null && opts.timeout !== "") a.push("-t", String(opts.timeout));
    if (opts.logLevel) a.push("--log-level", String(opts.logLevel));
    if (opts.noTeardown) a.push("--no-teardown");
    if (opts.noDiff) a.push("--no-diff");
    if (opts.profiler) a.push("--profiler");
    return a;
}

function runWorkerFile(item, opts) {
    return new Promise((resolveP) => {
        const child = spawn(process.execPath, [SCRIPT_PATH, ...workerArgs(item.file, opts)], {
            cwd: ROOT, env: { ...process.env, PAPAYA_WORKER: "1" },
        });
        let err = "";
        child.stdout.on("data", () => { /* result read from disk, not stdout */ });
        child.stderr.on("data", (d) => { err += d; });
        const fail = (msg) => resolveP({ tc_id: item.id, title: item.title, file: item.file, status: "error", duration_ms: 0, failed: { class: "worker_error", error: cleanText(msg) } });
        child.on("error", (e) => fail(e.message));
        child.on("close", () => {
            const rf = resolve(ROOT, "outputs", item.id, "latest", "result.json");
            try { if (existsSync(rf)) return resolveP(JSON.parse(readFileSync(rf, "utf8"))); } catch { }
            fail(err.trim().split(/\r?\n/).slice(-1)[0] || "worker produced no result.json");
        });
    });
}

async function runPool(worklist, opts, jobs) {
    const results = new Array(worklist.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const k = next++;
            if (k >= worklist.length) return;
            results[k] = await runWorkerFile(worklist[k], opts);
        }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, worklist.length) }, worker));
    return results;
}

// --- CI outputs + doctor ---

function xmlEscape(s) {
    return cleanText(s).replace(/[<>&"']/g, (c) =>
        ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
}

function junitXml(results) {
    const tests = results.length;
    const failures = results.filter((r) => r.status === "fail").length;
    const errors = results.filter((r) => r.status === "error").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const totalTime = (results.reduce((a, r) => a + (r.duration_ms || 0), 0) / 1000).toFixed(3);
    const cases = results.map((r) => {
        const time = ((r.duration_ms || 0) / 1000).toFixed(3);
        const name = xmlEscape(`${r.tc_id} ${r.title || ""}`.trim());
        const f = r.failed || {};
        if (r.status === "skipped") {
            return `    <testcase classname="papaya" name="${name}" time="${time}"><skipped message="quarantined"/></testcase>`;
        }
        if (r.status === "error") {
            return `    <testcase classname="papaya" name="${name}" time="${time}"><error message="${xmlEscape(f.class || "error")}">${xmlEscape(f.error || "")}</error></testcase>`;
        }
        if (r.status === "fail") {
            const msg = xmlEscape(`[${f.class || "unknown"}] step ${f.step}: ${f.name}`);
            return `    <testcase classname="papaya" name="${name}" time="${time}"><failure message="${msg}">${xmlEscape(f.error || "")}</failure></testcase>`;
        }
        return `    <testcase classname="papaya" name="${name}" time="${time}"/>`;
    }).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${totalTime}">
  <testsuite name="papaya" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${totalTime}">
${cases}
  </testsuite>
</testsuites>
`;
}

function doctorCommand() {
    let hard = 0;
    const okLine = (s) => console.log(`  ok    ${s}`);
    const warnLine = (s) => console.log(`  warn  ${s}`);
    const failLine = (s) => { hard++; console.log(`  FAIL  ${s}`); };

    const major = Number(process.versions.node.split(".")[0]);
    major >= 18 ? okLine(`node ${process.version}`) : failLine(`node ${process.version} (need >= 18)`);

    const ab = spawnSync("agent-browser", ["--version"], { encoding: "utf8" });
    if (ab.error) failLine("agent-browser not found — npm i -g agent-browser && agent-browser install");
    else okLine(`agent-browser ${(ab.stdout || "").trim() || "installed"}`);

    const envFile = resolve(ROOT, "env/env.yaml");
    if (!existsSync(envFile)) warnLine("env/env.yaml missing — run scripts/setup.sh");
    else {
        const env = readEnv(envFile);
        env.base_url ? okLine(`env/env.yaml base_url=${env.base_url}`) : warnLine("env/env.yaml has no base_url");
    }

    existsSync(resolve(ROOT, "tests")) ? okLine("tests/ present") : warnLine("tests/ missing — run scripts/setup.sh");

    const qFile = QUARANTINE_FILE();
    if (existsSync(qFile)) {
        try { JSON.parse(readFileSync(qFile, "utf8")); okLine(`quarantine.json valid (${loadQuarantine().length} quarantined)`); }
        catch { failLine("quarantine.json is not valid JSON"); }
    }
    existsSync(resolve(ROOT, "coverage.map")) ? okLine("coverage.map present") : warnLine("no coverage.map — `coverage` gap analysis disabled (copy coverage.map.example)");

    console.log("\n==> agent-browser doctor");
    if (!ab.error) {
        const r = spawnSync("agent-browser", ["doctor"], { stdio: "inherit" });
        if (r.status && r.status !== 0) hard++;
    } else {
        console.log("  (skipped — agent-browser not installed)");
    }
    console.log(hard ? `\ndoctor: ${hard} hard problem(s)` : "\ndoctor: ok");
    return hard ? 1 : 0;
}

// --- discover: list testable locators on a live page ---

function discoverCommand(opts) {
    const url = opts.file;
    if (!url) {
        console.error("usage: browser-test discover [-s <session>] <url>");
        console.error("");
        console.error("Opens <url> and lists all testable locators — data-qa/testid attributes,");
        console.error("placeholders, and interactive elements — so you can choose stable selectors.");
        return 1;
    }
    const session = opts.session || `papaya_discover_${process.pid}`;
    const ab = (abArgs, opts = {}) => {
        const res = spawnSync("agent-browser", ["--session", session, ...abArgs], {
            cwd: ROOT, encoding: "utf8", timeout: 30000, maxBuffer: 10 * 1024 * 1024,
            // Exploration ingests live page content into the agent's context, so
            // mark it as untrusted with agent-browser's boundary markers. An
            // explicit env value still wins; locator extraction uses a fallback
            // regex, so the markers don't disturb discover's parsing.
            env: { AGENT_BROWSER_CONTENT_BOUNDARIES: "1", ...process.env },
        });
        if (!opts.allowFail && (res.error || res.status !== 0)) {
            const msg = (res.stderr || res.stdout || "").trim().split("\n").slice(-1)[0]
                || res.error?.message || `exit ${res.status}`;
            throw new Error(msg);
        }
        return res.stdout || "";
    };
    try {
        process.stdout.write(`Discovering ${url} ...\n`);
        ab(["open", url]);

        // Extract data-qa/testid, placeholders, and labelled interactive elements.
        const js =
            `(function(){var out=[];` +
            `["data-qa","data-testid","data-test","data-cy"].forEach(function(a){` +
            `document.querySelectorAll("["+a+"]").forEach(function(el){` +
            `out.push({kind:a,val:el.getAttribute(a),tag:el.tagName.toLowerCase(),` +
            `hint:(el.getAttribute("aria-label")||el.textContent||"").trim().replace(/\\s+/g," ").slice(0,50)});` +
            `});});` +
            `document.querySelectorAll("[placeholder]").forEach(function(el){` +
            `out.push({kind:"placeholder",val:el.getAttribute("placeholder"),tag:el.tagName.toLowerCase(),hint:""});` +
            `});` +
            `document.querySelectorAll("button,a[href]").forEach(function(el){` +
            `if(el.closest("[data-qa]")||el.closest("[data-testid]")) return;` +
            `var n=(el.getAttribute("aria-label")||el.textContent||"").trim().replace(/\\s+/g," ").slice(0,40);` +
            `if(n) out.push({kind:"text",val:n,tag:el.tagName.toLowerCase(),hint:""});` +
            `});` +
            `var seen=new Set();` +
            `return JSON.stringify(out.filter(function(x){var k=x.kind+"|"+x.val;if(seen.has(k))return false;seen.add(k);return true;}));` +
            `})()`;

        const evalOut = ab(["eval", js], { allowFail: true });
        // agent-browser wraps string return values in outer quotes: "\"[...]\""
        // Parse the outer JSON string first, then parse the inner array.
        let items = [];
        try {
            const clean = evalOut.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
            const inner = JSON.parse(clean);           // outer string → inner JSON string
            items = JSON.parse(inner);                 // inner JSON string → array
        } catch {
            const m = evalOut.match(/(\[[\s\S]*?\])/); // fallback: direct array match
            if (m) { try { items = JSON.parse(m[1]); } catch { /* ignore */ } }
        }

        const testAttrItems = items.filter((x) => x.kind.startsWith("data-"));
        const phItems = items.filter((x) => x.kind === "placeholder");
        const textItems = items.filter((x) => x.kind === "text");

        if (testAttrItems.length) {
            console.log("\n── test attributes  →  find first \'[attr=\"val\"]\' (most stable locator):");
            for (const it of testAttrItems) {
                const locator = `find first '[${it.kind}="${it.val}"]'`;
                console.log(`  ${locator.padEnd(52)} <${it.tag}>${it.hint ? `  ${it.hint}` : ""}`);
            }
        }
        if (phItems.length) {
            console.log("\n── placeholders  →  find placeholder \"...\" fill/type:");
            for (const it of phItems) console.log(`  find placeholder "${it.val}"`);
        }
        if (textItems.length) {
            console.log("\n── links / buttons by text  →  find role ... --name \"...\":");
            for (const it of textItems) {
                const role = it.tag === "button" ? "button" : "link";
                console.log(`  find role ${role} click --name "${it.val}"`);
            }
        }
        if (!items.length) console.log("\n(no data-qa/placeholder/text locators found — see snapshot below)");

        // Always print the interactive snapshot so @eN refs are available too.
        const snap = ab(["snapshot", "-i"], { allowFail: true });
        if (snap) {
            console.log("\n── interactive snapshot  (use @eN refs while this session stays open):");
            console.log(snap);
        }
        console.log(`Continue exploring with:  agent-browser --session ${session} snapshot -i`);
        console.log(`Close this discover browser with:  agent-browser --session ${session} close`);
        console.log("In testcase bash blocks, prefix saved commands with:  agent-browser --session \"$SESSION\"");
    } catch (err) {
        console.error(`discover failed: ${err.message}`);
        return 1;
    }
    return 0;
}

// --- entrypoint ---

try {
    const opts = parseArgs(process.argv);
    if (opts.command === "new") process.exit(await newCommand(process.argv));
    if (opts.command === "discover") process.exit(discoverCommand(opts));
    if (opts.command === "list") process.exit(listCommand(opts));
    if (opts.command === "history") process.exit(historyCommand(opts.file || null));
    if (opts.command === "heal") process.exit(healCommand(process.argv));
    if (opts.command === "flaky") process.exit(flakyCommand());
    if (opts.command === "quarantine") process.exit(quarantineCommand(process.argv));
    if (opts.command === "coverage") process.exit(coverageCommand());
    if (opts.command === "eval") process.exit(evalCommand());
    if (opts.command === "doctor") process.exit(doctorCommand());
    if (!opts.file) throw new Error("Missing testcase file or directory");

    if (opts.command === "validate") {
        const files = expandFiles(opts.file);
        if (!files.length) throw new Error(`Not found: ${opts.file}`);
        let bad = 0;
        for (const f of files) {
            try {
                const tc = readCase(f);
                if (validate(tc, f) !== 0) bad = 1;
            } catch (err) {
                console.error(`ERROR in ${f}: ${err.message}`);
                bad = 1;
            }
        }
        // Cross-file: TC-IDs must be globally unique (checked against the whole
        // tests/ dir even when validating a single file, since collisions are a
        // property of the set, not one file).
        const dupScope = statSync(resolve(ROOT, opts.file)).isDirectory() ? files : expandFiles("tests");
        const dups = duplicateIds(dupScope);
        for (const [id, fs] of Object.entries(dups)) {
            console.error(`- err[duplicate_id] frontmatter: id ${id} used by multiple files: ${fs.join(", ")}\n  -> fix: give each testcase a unique TC-NNN id`);
            bad = 1;
        }
        process.exit(bad);
    }

    if (opts.command !== "run") throw new Error(`Unknown command: ${opts.command}`);
    if (opts.ci) opts.verbose = false;
    const jobs = resolveJobs(opts.jobs);
    let anyFail = 0;
    let executed = 0;
    let runningDir = false;
    const collected = [];
    const log = (m) => (opts.ci ? console.error : console.log)(m);
    try {
        const files = expandFiles(opts.file);
        if (!files.length) throw new Error(`Not found: ${opts.file}`);
        runningDir = statSync(resolve(ROOT, opts.file)).isDirectory();
        const quarantined = new Set(loadQuarantine());
        if (opts.session && files.length > 1) {
            log(`WARN  --session "${opts.session}" is shared across ${files.length} flows; state will leak between them. Omit -s for per-flow isolation.`);
        }
        const dups = process.env.PAPAYA_WORKER ? {} : duplicateIds(runningDir ? files : expandFiles("tests"));
        if (Object.keys(dups).length) {
            anyFail = 1;
            for (const [id, fs] of Object.entries(dups)) {
                log(`ERROR duplicate TC-ID ${id}: ${fs.join(", ")}`);
                collected.push({ tc_id: id, title: "", file: "", status: "error", duration_ms: 0, failed: { class: "duplicate_id", error: `id ${id} used by: ${fs.join(", ")}` } });
            }
        } else {
            const slots = new Array(files.length).fill(null);
            const worklist = [];
            files.forEach((f, idx) => {
                let tc;
                try { tc = readCase(f); }
                catch (err) {
                    anyFail = 1;
                    log(`ERROR ${basename(f)}: ${err.message}`);
                    slots[idx] = { tc_id: basename(f), title: "", file: f, status: "error", duration_ms: 0, failed: { class: "parse_error", error: cleanText(err.message) } };
                    return;
                }
                if (runningDir && !opts.includeQuarantined && quarantined.has(tc.meta.id)) {
                    log(`SKIP  ${tc.meta.id} (quarantined — heal it, then ./browser-test quarantine remove ${tc.meta.id})`);
                    slots[idx] = { tc_id: tc.meta.id, title: tc.meta.title || "", file: f, status: "skipped", duration_ms: 0, failed: null };
                    return;
                }
                worklist.push({ idx, file: f, id: tc.meta.id, title: tc.meta.title || "", tc });
            });
            executed = worklist.length;

            if (jobs > 1 && worklist.length > 1) {
                // Parallel: one isolated child process per testcase, ≤ jobs alive.
                log(`Running ${worklist.length} flows with ${jobs} workers…`);
                const results = await runPool(worklist, opts, jobs);
                results.forEach((r, k) => {
                    slots[worklist[k].idx] = r;
                    if (r.status !== "pass") anyFail = 1;
                });
            } else {
                // Sequential, in-process (default): no spawn overhead, fully
                // deterministic — identical to the pre-parallel behavior.
                for (const item of worklist) {
                    let code = 1;
                    try {
                        const runner = new Runner({ ...opts, file: item.file }, item.tc);
                        code = runner.run();
                        slots[item.idx] = runner.result || { tc_id: item.id, title: item.title, file: item.file, status: "error", duration_ms: 0, failed: { class: "runtime_error", error: "runner produced no result" } };
                    } catch (err) {
                        log(`ERROR ${item.id}: ${cleanText(err.message)}`);
                        slots[item.idx] = { tc_id: item.id, title: item.title, file: item.file, status: "error", duration_ms: 0, failed: { class: "runtime_error", error: cleanText(err.message) } };
                    }
                    if (code !== 0) anyFail = 1;
                }
            }
            for (const s of slots) if (s) collected.push(s);
        }
    } catch (err) {
        anyFail = 1;
        log(`ERROR ${cleanText(err.message || err)}`);
        collected.push({ tc_id: "(preflight)", title: "", file: "", status: "error", duration_ms: 0, failed: { class: "preflight_error", error: cleanText(err.message || err) } });
    } finally {
        // Reports always emit. In CI, an unwritable JUnit path is a hard fail —
        // a missing report must not pass as green.
        if (opts.junit) {
            try { writeFileSync(resolve(ROOT, opts.junit), junitXml(collected)); }
            catch (e) { console.error(`${opts.ci ? "ERROR" : "WARN"}: could not write JUnit: ${e.message}`); if (opts.ci) anyFail = 1; }
        }
        const zeroExecuted = runningDir && executed === 0 && collected.length > 0;
        if (zeroExecuted) anyFail = 1;
        const count = (s) => collected.filter((r) => r.status === s).length;
        if (opts.ci) {
            const summaryObj = {
                schema_version: 2, runner_version: VERSION, contract_version: CONTRACT_VERSION,
                total: collected.length, executed,
                passed: count("pass"), failed: count("fail"), errored: count("error"), skipped: count("skipped"),
                zero_executed: zeroExecuted || undefined,
                ok: anyFail === 0,
                results: collected.map((r) => ({
                    tc_id: r.tc_id, status: r.status, duration_ms: r.duration_ms,
                    class: r.failed?.class || null, step: r.failed?.step || null,
                })),
            };
            process.stdout.write(`@@PAPAYA_RESULT@@ ${JSON.stringify(summaryObj)}\n`);
        } else if (zeroExecuted) {
            console.error("ERROR: nothing executed (all flows quarantined/skipped) — gate fails to avoid false green. Use --include-quarantined to run them.");
        } else if (collected.length > 1) {
            // Tally line after a batch run (per-test PASS/FAIL printed above).
            const parts = [`${count("pass")} passed`];
            if (count("fail")) parts.push(`${count("fail")} failed`);
            if (count("error")) parts.push(`${count("error")} errored`);
            if (count("skipped")) parts.push(`${count("skipped")} skipped`);
            console.log(`\n${collected.length} testcases: ${parts.join(", ")}`);
        }
    }
    process.exit(anyFail);
} catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(1);
}
