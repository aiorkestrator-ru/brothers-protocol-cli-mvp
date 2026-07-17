# Changelog

## 0.8.1 — 2026-07-18

Первый догфуд-релиз: изменения сделаны через сам Brothers Protocol
(цепочка TASK-001 → BATON-001 → TASK-002 в `coordination/` этого репозитория).

- fix: `brothers init` в директории с существующим README.md больше не перезаписывает его
  (баг найден при инициализации протокола в собственном репо)
- feat(tui): TaskDetail показывает статус подписи батона (✓ подписан / ✗ невалиден / ⚠ без подписи)
  и результат testRun (команда, exit code)
- tests: 13 e2e (регресс на README-баг)

## 0.8.0 — 2026-07-17

- feat: HMAC-SHA256-подпись батонов; секрет в `.brothers-secret` (0600, авто-gitignore);
  отредактированный или рукописный baton отклоняется на `start --with-baton`
- feat: `relay-check --run-tests` — реальный прогон тестовой команды проекта
  (`test_command` в конфиге, автодетект при `init`, override `--test-command`);
  провал тестов блокирует выдачу батона, успех фиксируется в `baton.testRun`
- refactor: cli.ts (1932 строки) распилен на `src/core/*` + `src/providers.ts` без изменения поведения
- security: npm audit чистый (ws обновлён)
- docs: README переписан — честное описание гарантий, позиционирование vs issue-трекеров

## 0.7.0 и раньше

TUI-дашборд (`brothers ui`), провайдер claude-code, stack-детект и MCP-подсказки,
базовый relay-протокол. См. git-историю.
