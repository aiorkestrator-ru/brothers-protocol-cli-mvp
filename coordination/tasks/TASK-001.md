# TASK-001: TUI: показывать статус подписи батона и результат testRun

## Description
TUI: показывать статус подписи батона и результат testRun

## Created
2026-07-17 22:51:27

## Assignee
claude

## Priority
high

## Details
В экране TaskDetail для батонов задачи выводить: подпись valid/invalid/missing и итог testRun (команда, exit code). Использовать checkBatonSignature из core/relay.

## Dependencies
None

## Done Criteria
- [ ] Code works
- [ ] Tests pass
- [ ] Documentation updated

## Files
- src/tui/lib.ts
- src/tui/screens/TaskDetail.tsx

---
*Status: COMPLETED*
*Next: Run brothers start TASK-001*
