import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, writeText } from './fsutil.js';
import { type Config, DEFAULT_CONFIG, detectTestCommand, loadOrCreateSecret, saveConfig } from './config.js';
import { detectStack } from './stack.js';

export function setupProject(root: string, projectName: string): void {
  const coordination = path.join(root, 'coordination');
  ensureDir(path.join(coordination, 'tasks'));
  ensureDir(path.join(coordination, 'reports'));
  ensureDir(path.join(coordination, 'templates'));
  ensureDir(path.join(coordination, 'prompts'));
  ensureDir(path.join(coordination, 'archive'));
  ensureDir(path.join(coordination, 'batons'));

  const detected = detectStack(root);
  const testCommand = detectTestCommand(root);
  const config: Config = {
    ...DEFAULT_CONFIG,
    project: projectName,
    ...(testCommand && { test_command: testCommand }),
    ...(detected.stack.length > 0  && { stack: detected.stack }),
    ...(detected.docs.length  > 0  && { stack_docs: detected.docs }),
    ...(detected.mcp.length   > 0  && { mcp_suggested: detected.mcp }),
  };

  saveConfig(root, config);
  // Секрет для подписи батонов создаётся сразу и сразу попадает в .gitignore
  loadOrCreateSecret(root);

  writeText(
    path.join(coordination, 'templates', 'task-template.md'),
    `# TASK-{ID}: {TITLE}

## Description
{DESCRIPTION}

## Created
{DATE}

## Assignee
{ASSIGNEE}

## Priority
{PRIORITY}

## Details
{DETAILS}

## Dependencies
{DEPENDENCIES}

## Done Criteria
- [ ] Code works
- [ ] Tests pass
- [ ] Documentation updated

## Files
{FILES}

---
*Status: CREATED*
`,
  );

  writeText(
    path.join(coordination, 'templates', 'report-template.md'),
    `# REPORT-{ID}: {TASK_TITLE}

## DATE
{DATE}

## EXECUTOR
{EXECUTOR}

## STATUS
{STATUS}

## TASK
{TASK_ID}

## WORK DONE
- ✅ {ITEM_1}

## FILES CHANGED
- {FILE_1}

## TESTS
{TEST_OUTPUT}

## RESULT
{RESULT}

## NEXT STEPS
- [ ] {NEXT_STEP_1}
`,
  );

  // README пишем только если его нет: init в существующем проекте не должен затирать чужой README
  if (!fs.existsSync(path.join(root, 'README.md'))) {
    writeText(
      path.join(root, 'README.md'),
      `# ${projectName}

MVP implementation for Brothers Protocol CLI.

## Quick Start

\`\`\`bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js task "My first task"
node dist/cli.js start TASK-001
node dist/cli.js report TASK-001 --done "Implemented flow" --tests "npm test"
node dist/cli.js status
\`\`\`
`,
    );
  }

  if (!fs.existsSync(path.join(root, 'AI_RULES.md'))) {
    writeText(path.join(root, 'AI_RULES.md'), '# AI Rules\n\nAdd project-level AI execution rules here.\n');
  }
}
