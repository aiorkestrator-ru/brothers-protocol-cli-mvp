# Brothers Protocol CLI

> **v0.8.0** · Markdown-first CLI for safe task handoff between AI agents

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-12%2F12%20pass-brightgreen)](#testing)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

---

## The Problem

Multi-agent AI pipelines fail silently. Agent B starts working assuming Agent A finished — but there's **no proof**:

- Did Agent A actually complete the task?
- Were the files written to disk?
- Did tests pass?
- Is the architecture documented?

Without verification, you burn tokens on broken foundations.

## The Solution: Relay Baton

Brothers Protocol introduces a **Relay Baton** — an HMAC-signed JSON token that proves a dependency chain was verified before the next agent starts.

```
Agent A completes → verified → BATON issued & signed → Agent B starts with proof
```

The baton checks:
1. Dependency task status = `COMPLETED`
2. Report exists with all 5 required sections
3. All files listed in `FILES CHANGED` exist on disk
4. Tests section ≠ "not run" — or, with `--run-tests`, the test suite is **actually executed** and its exit code recorded
5. No circular dependencies (DFS)
6. Baton not expired (TTL: 72h, configurable)
7. Baton signature is valid — a baton that was hand-crafted or edited after issue is rejected

**No baton → no start.** The protocol is enforced, not optional.

### What the baton does and does not prove

Honest scope: the baton proves **process compliance** — the dependency was completed, documented, its artifacts exist, and (with `--run-tests`) the test suite passed at issue time. It does not prove the code is *correct*; that is what your tests and reviews are for. The signature makes the baton tamper-evident: an agent cannot fake a "verified" state by writing the JSON by hand.

---

## Quick Start

```bash
# Install
git clone https://github.com/aiorkestrator-ru/brothers-protocol-cli-mvp
cd brothers-protocol-cli-mvp
npm install && npm run build

# Alias for convenience
alias brothers="node $(pwd)/dist/cli.js"

# Initialize a project (creates coordination/, .brothers-config.json, .brothers-secret)
brothers init my-project
cd my-project   # or: brothers commands work from any subdir

# Configure AI provider
brothers ai setup --provider mock --model mock-v1

# Create and run a task
brothers task "Design API schema" --priority high
brothers start TASK-001

# Complete it manually
brothers report TASK-001 \
  --done "Designed REST endpoints;Auth flow" \
  --files "docs/api-schema.md" \
  --tests "N/A (design phase)" \
  --next "Implement auth endpoint"

# Create dependent task and verify handoff
brothers task "Implement auth" --depends-on TASK-001
brothers relay-check TASK-002 --run-tests   # runs test suite, issues signed BATON-001
brothers start TASK-002 --with-baton BATON-001

# Project overview
brothers status
brothers next --create 1
```

---

## Brothers vs an issue tracker

They solve different layers and work well together:

| | GitHub Issues / boards | Brothers Protocol |
|---|---|---|
| Audience | humans planning work | agents executing work |
| Unit | issue ("what to do") | task + report + baton ("what was done, with proof") |
| Verification | none — status is declared | enforced — artifacts checked, tests run, baton signed |
| Scope | project/team level | inside one delivery chain |

Typical setup: an issue tracks the feature; the agents working on it coordinate through `coordination/` with batons gating each handoff.

---

## Use Cases

### Manual AI workflow (paste prompts to ChatGPT/Claude)

```bash
brothers task "Build payment service" --priority high --files "src/payments.ts"
brothers start TASK-001          # generates structured prompt → prompts/TASK-001-prompt.txt
# paste into your AI, do the work
brothers report TASK-001 --done "..." --files "..." --tests "PASS 12/12" --next "Add rate limiting"
brothers next --create 1         # auto-creates TASK-002: Add rate limiting
```

### Two AI agents in sequence (dependency chain)

```bash
# Agent A: design
brothers start TASK-001 --auto --ai anthropic --model claude-sonnet-4-6

# Gate: verify before Agent B starts — run the real test suite
brothers relay-check TASK-002 --strict --run-tests    # issues signed BATON-001 or fails loudly

# Agent B: implement
brothers start TASK-002 --auto --ai openai --model gpt-4o --with-baton BATON-001
```

### CI/CD pipeline

```yaml
- name: Quality Gate
  run: |
    brothers relay-check TASK-002 --strict --run-tests --json > baton.json
    cat baton.json | jq '.passed' | grep true   # fails CI if false

- name: Implementation Stage
  run: |
    BATON_ID=$(cat baton.json | jq -r '.batonId')
    brothers start TASK-002 --auto --ai openai --model gpt-4o --with-baton $BATON_ID
```

### Retry on AI failure (exponential backoff)

```bash
brothers ai setup --provider openai --retries 3 --retry-delay-ms 1000
brothers start TASK-001 --auto
# attempt 1: 429 rate limit → wait 1000ms
# attempt 2: 503 timeout   → wait 2000ms
# attempt 3: success        → report created
```

### Secret sanitization

```bash
brothers ai setup --sanitize on   # default: on

brothers prompt TASK-001 --sanitize-preview
# RAW:       "Stripe key: sk-live-..." (real value)
# SANITIZED: "Stripe key: [REDACTED_API_KEY]..."

brothers start TASK-001   # sends sanitized prompt to AI
```

---

## Commands

| Command | Description |
|---------|-------------|
| `brothers init [name]` | Initialize project structure + signing secret |
| `brothers ai setup` | Configure AI provider |
| `brothers ai test [--live]` | Test AI connectivity |
| `brothers task <title>` | Create a task |
| `brothers link <id> --depends-on` | Add dependencies (cycle-safe) |
| `brothers start <id> [--auto] [--dry-run]` | Start task, optionally call AI |
| `brothers prompt <id> [--save]` | Preview prompt without starting |
| `brothers report <id>` | Create task report |
| `brothers relay-check <id> [--strict] [--run-tests] [--json]` | Verify dependencies, run tests, issue signed baton |
| `brothers baton-info <id> [--json]` | Baton details (TTL, signature status, test run) |
| `brothers status` | Project overview |
| `brothers next [--create N]` | Suggest or create next task |
| `brothers stack [--show]` | Detect tech stack, suggest MCP servers |
| `brothers context <id>` | Generate AI prompt without status change |
| `brothers ui` | Interactive TUI dashboard |

---

## File Structure

```
coordination/
├── tasks/       TASK-XXX.md   (CREATED → IN_PROGRESS → COMPLETED)
├── reports/     REPORT-XXX.md (5 required sections)
├── batons/      BATON-XXX.json (signed proof of completion, TTL 72h)
├── prompts/     TASK-XXX-prompt.txt, TASK-XXX-response.txt
└── templates/   task.md, report.md
.brothers-config.json   project config
.brothers-secret        HMAC signing key (0600, auto-gitignored — never commit)
```

### BATON-XXX.json

```json
{
  "id": "BATON-001",
  "createdAt": "2026-07-17 14:00:00",
  "expiresAt": "2026-07-20 14:00:00",
  "toTask": "TASK-002",
  "dependencies": [
    {
      "taskId": "TASK-001",
      "reportId": "REPORT-001",
      "artifactsChecked": ["src/auth.ts"],
      "warnings": []
    }
  ],
  "checks": ["dependencies_completed", "reports_exist", "report_sections_valid", "artifacts_exist", "tests_passed", "baton_signed"],
  "passed": true,
  "testRun": {
    "command": "npm test",
    "exitCode": 0,
    "ranAt": "2026-07-17 14:00:00",
    "durationMs": 2140,
    "outputTail": "# pass 12\n# fail 0"
  },
  "signature": "hex HMAC-SHA256 over the baton payload"
}
```

---

## Relay Baton Algorithm

```
relay-check TASK-002 [--run-tests]:
  for each dependency of TASK-002:
    1. dependency file exists?               → error if not
    2. dependency status = COMPLETED?        → error if not
    3. report for dependency exists?         → error if not
    4. report contains all 5 sections?      → error if not
       (WORK DONE, FILES CHANGED, TESTS, RESULT, NEXT STEPS)
    5. all files in FILES CHANGED exist?     → error if not
    6. TESTS ≠ "not run / not executed"?    → warning (--strict → error)
    7. circular dependency check (DFS)?      → error if cycle found

  if --run-tests:
    run test_command (config or --test-command)
    exit code ≠ 0 → error, no baton issued
    exit code = 0 → testRun recorded, "not run" warnings cleared

  if all pass:
    → build BATON-XXX payload with expiresAt = now + 72h
    → sign payload with HMAC-SHA256 (.brothers-secret)
    → write BATON-XXX.json, return batonId

start TASK-002 --with-baton BATON-XXX:
  → recompute signature; edited/hand-crafted baton → hard error
  → check passed / TTL / task match / dependency set match
```

The signature is computed over a canonical serialization (recursively sorted keys), so reformatting the file does not break it — changing any value does.

---

## AI Providers

| Provider | `--ai` flag | Notes |
|----------|-------------|-------|
| Mock | `mock` | For testing, uses `BROTHERS_MOCK_AI_RESPONSE` env var |
| Claude Code | `claude-code` | Uses local Claude Code session, no API key required |
| OpenAI | `openai` | Requires `OPENAI_API_KEY` |
| Anthropic | `anthropic` | Requires `ANTHROPIC_API_KEY` |

---

## Testing

```bash
npm test        # 12 e2e tests (Node.js built-in test runner, CLI as black box)
npm run smoke   # full end-to-end smoke run
```

Test coverage:
- MVP flow: init → task → start → report → status → next
- Relay flow: dependency requires baton + JSON endpoints
- Auto mode: mock provider creates report from AI response
- AI setup defaults + sanitize + retry backoff
- Relay strict mode blocks warnings
- Relay strict JSON output format
- Prompt preview + dry-run + ai test command
- Baton is HMAC-signed, secret auto-gitignored
- Tampered / unsigned batons are rejected
- `--run-tests`: passing run recorded in baton, failing run blocks baton

---

## Configuration (`.brothers-config.json`)

```json
{
  "project": "my-project",
  "ai_provider": "anthropic",
  "ai_model": "claude-sonnet-4-6",
  "auto_sanitize_prompt": true,
  "ai_retries": 3,
  "ai_retry_delay_ms": 1000,
  "baton_ttl_hours": 72,
  "test_command": "npm test"
}
```

`test_command` is auto-detected at `init` (npm test script / pytest) and can be overridden per run with `--test-command`.

---

## Architecture

```
src/
├── cli.ts            command definitions (commander), no business logic
├── providers.ts      AI provider calls (mock / claude-code / openai / anthropic)
├── core/
│   ├── config.ts     config load/save, signing secret, test command detection
│   ├── fsutil.ts     fs helpers, atomic ID allocation
│   ├── tasks.ts      task markdown, statuses, dependencies, cycle detection
│   ├── reports.ts    report create/parse/validate
│   ├── relay.ts      relay validation, baton issue/verify, HMAC, test runner
│   ├── prompt.ts     prompt building + secret sanitization
│   ├── stack.ts      tech stack detection, MCP suggestions
│   └── init.ts       project scaffolding
└── tui/              Ink dashboard (brothers ui)
```

---

## Why "Brothers Protocol"?

One agent passes the baton to the next — like relay runners. The protocol ensures the previous runner actually finished their leg before the next one starts.

No trust without proof.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
