# Brothers Protocol CLI

> **v0.6.0** · Markdown-first CLI for safe task handoff between AI agents

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-7%2F7%20pass-brightgreen)](#testing)
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

Brothers Protocol introduces a **Relay Baton** — a signed JSON token that proves a dependency chain was verified before the next agent starts.

```
Agent A completes → verified → BATON issued → Agent B starts with proof
```

The baton checks:
1. Dependency task status = `COMPLETED`
2. Report exists with all 5 required sections
3. All files listed in `FILES CHANGED` exist on disk
4. Tests section ≠ "not run"
5. No circular dependencies (DFS)
6. Baton not expired (TTL: 72h, configurable)

**No baton → no start.** The protocol is enforced, not optional.

---

## Quick Start

```bash
# Install
git clone https://github.com/aiorkestrator-ru/brothers-protocol-cli-mvp
cd brothers-protocol-cli-mvp
npm install && npm run build

# Alias for convenience
alias brothers="node $(pwd)/dist/cli.js"

# Initialize a project
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
brothers relay-check TASK-002       # issues BATON-001
brothers start TASK-002 --with-baton BATON-001

# Project overview
brothers status
brothers next --create 1
```

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

# Gate: verify before Agent B starts
brothers relay-check TASK-002 --strict    # issues BATON-001 or fails loudly

# Agent B: implement
brothers start TASK-002 --auto --ai openai --model gpt-4o --with-baton BATON-001
```

### CI/CD pipeline

```yaml
- name: Quality Gate
  run: |
    brothers relay-check TASK-002 --strict --json > baton.json
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

brothers task "Update payment service" \
  --details "Stripe key: sk-live-abc123, DB: postgres://admin:secret@prod"

brothers prompt TASK-001 --sanitize-preview
# RAW:       "Stripe key: sk-live-abc123..."
# SANITIZED: "Stripe key: [REDACTED_API_KEY]..."

brothers start TASK-001   # sends sanitized prompt to AI
```

---

## Commands

| Command | Description |
|---------|-------------|
| `brothers init [name]` | Initialize project structure |
| `brothers ai setup` | Configure AI provider |
| `brothers ai test [--live]` | Test AI connectivity |
| `brothers task <title>` | Create a task |
| `brothers link <id> --depends-on` | Add dependencies (cycle-safe) |
| `brothers start <id> [--auto] [--dry-run]` | Start task, optionally call AI |
| `brothers prompt <id> [--save]` | Preview prompt without starting |
| `brothers report <id>` | Create task report |
| `brothers relay-check <id> [--strict] [--json]` | Verify dependencies, issue baton |
| `brothers baton-info <id> [--json]` | Baton details (shows TTL) |
| `brothers status` | Project overview |
| `brothers next [--create N]` | Suggest or create next task |

---

## File Structure

```
coordination/
├── tasks/       TASK-XXX.md   (CREATED → IN_PROGRESS → COMPLETED)
├── reports/     REPORT-XXX.md (5 required sections)
├── batons/      BATON-XXX.json (proof of completion, TTL 72h)
├── prompts/     TASK-XXX-prompt.txt, TASK-XXX-response.txt
└── templates/   task.md, report.md
```

### BATON-XXX.json

```json
{
  "id": "BATON-001",
  "createdAt": "2026-03-01 14:00:00",
  "expiresAt": "2026-03-04 14:00:00",
  "toTask": "TASK-002",
  "dependencies": [
    {
      "taskId": "TASK-001",
      "reportId": "REPORT-001",
      "artifactsChecked": ["src/auth.ts"],
      "warnings": []
    }
  ],
  "checks": ["dependencies_completed", "reports_exist", "report_sections_valid", "artifacts_exist"],
  "passed": true
}
```

---

## Relay Baton Algorithm

```
relay-check TASK-002:
  for each dependency of TASK-002:
    1. dependency file exists?               → error if not
    2. dependency status = COMPLETED?        → error if not
    3. report for dependency exists?         → error if not
    4. report contains all 5 sections?      → error if not
       (WORK DONE, FILES CHANGED, TESTS, RESULT, NEXT STEPS)
    5. all files in FILES CHANGED exist?     → error if not
    6. TESTS ≠ "not run / not executed"?    → warning (--strict → error)
    7. circular dependency check (DFS)?      → error if cycle found

  if all pass:
    → write BATON-XXX.json with expiresAt = now + 72h
    → return batonId
```

---

## AI Providers

| Provider | `--ai` flag | Notes |
|----------|-------------|-------|
| Mock | `mock` | For testing, uses `BROTHERS_MOCK_AI_RESPONSE` env var |
| OpenAI | `openai` | Requires `OPENAI_API_KEY` |
| Anthropic | `anthropic` | Requires `ANTHROPIC_API_KEY` |

---

## Testing

```bash
npm test        # 7 unit tests (Node.js built-in test runner)
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

---

## Configuration (`coordination/brothers-config.json`)

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "sanitize": true,
  "retries": 3,
  "retry_delay_ms": 1000,
  "baton_ttl_hours": 72
}
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
