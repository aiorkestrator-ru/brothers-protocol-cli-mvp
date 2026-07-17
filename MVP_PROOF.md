# MVP Proof of Operability

Date: 2026-02-14

## 1) Automated test suite

Command:

```bash
npm test
```

Result:

```text
TAP version 13
# Subtest: MVP flow: init -> task -> start -> report -> status -> next
ok 1 - MVP flow: init -> task -> start -> report -> status -> next
# Subtest: Relay flow: dependency requires baton + json endpoints
ok 2 - Relay flow: dependency requires baton + json endpoints
# Subtest: Auto mode: mock provider creates report from AI response
ok 3 - Auto mode: mock provider creates report from AI response
# Subtest: AI setup defaults + sanitize + retry backoff in auto mode
ok 4 - AI setup defaults + sanitize + retry backoff in auto mode
# Subtest: Relay strict mode blocks warnings
ok 5 - Relay strict mode blocks warnings
# Subtest: Relay strict JSON is JSON-only and does not issue baton
ok 6 - Relay strict JSON is JSON-only and does not issue baton
# Subtest: Prompt preview + dry-run + ai test command
ok 7 - Prompt preview + dry-run + ai test command
1..7
# tests 7
# pass 7
# fail 0
```

## 2) Reproducible smoke run

Command:

```bash
npm run smoke
```

Result (key lines):

```text
Initialized Brothers Protocol project at: /tmp/.../project
AI config updated
AI test passed
Created TASK-001: Smoke: handoff flow
--- RAW PROMPT ---
--- SANITIZED PROMPT ---
Task TASK-001 started
Report created: REPORT-001
BROTHERS STATUS
  COMPLETED: 1
Reports total: 1
Created TASK-002: Prepare v0.2 relay validation
Updated dependencies for TASK-002
Relay validation passed for TASK-002
Baton: BATON-001
BATON: BATON-001
Task TASK-002 started
Baton verified: BATON-001
Auto mode enabled: sending prompt to AI...
AI attempt 1 failed
Retrying in 1ms...
Auto report created: REPORT-002
```

## 3) Private repository delivery

GitHub repository:

```text
https://github.com/aiorkestrator-ru/brothers-protocol-cli-mvp
Visibility: PRIVATE
```

Push result:

```text
[new branch] main -> main
branch 'main' set up to track 'origin/main'
```
