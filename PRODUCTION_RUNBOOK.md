# Production Runbook (MVP)

## Requirements
- Node.js 20+
- npm 10+

## Install

```bash
npm install
npm run build
git config credential.helper '!gh auth git-credential'
```

Direct PAT push (one-shot, no password prompt):

```bash
export GITHUB_TOKEN="<your_pat>"
git push "https://x-access-token:${GITHUB_TOKEN}@github.com/aiorkestrator-ru/brothers-protocol-cli-mvp.git" main
```

## Local Usage

```bash
node dist/cli.js init
node dist/cli.js ai setup --provider mock --model mock-v1 --sanitize on --retries 2 --retry-delay-ms 500
node dist/cli.js ai test
node dist/cli.js task "Fix calculator bug" --priority high --assignee claude
node dist/cli.js prompt TASK-001 --sanitize-preview --save
node dist/cli.js start TASK-001 --dry-run
node dist/cli.js start TASK-001 --ai claude
node dist/cli.js report TASK-001 --done "Fixed selectors;Added tests" --files "index.html,assets/js/calculator.js" --tests "PASS" --next "Deploy to staging"
node dist/cli.js task "Deploy to staging" --depends-on TASK-001
node dist/cli.js relay-check TASK-002 --strict
node dist/cli.js start TASK-002 --with-baton BATON-001
node dist/cli.js relay-check TASK-002 --json
node dist/cli.js baton-info BATON-001 --json
node dist/cli.js task "Auto follow-up"
BROTHERS_MOCK_AI_RESPONSE="## WORK DONE\n- ✅ Auto done\n## FILES CHANGED\n- src/cli.ts\n## TESTS\nPASS\n## RESULT\nDone\n## NEXT STEPS\n- [ ] Deploy" node dist/cli.js start TASK-003 --auto
node dist/cli.js status
node dist/cli.js next
```

## Quality Gate

```bash
npm test
```

## Release Gate
- Build passes
- e2e test passes
- Repo pushed to private GitHub remote
