#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

import { boolFromMode, splitList, writeText } from './core/fsutil.js';
import {
  type Config,
  coordinationRoot,
  findProjectRoot,
  loadConfig,
  loadOrCreateSecret,
  saveConfig,
} from './core/config.js';
import {
  type TaskStatus,
  createTask,
  detectCycles,
  normalizeTaskStatus,
  parseDependencies,
  readTaskStatus,
  replaceDependenciesSection,
  requireTaskContent,
  updateTaskStatus,
} from './core/tasks.js';
import {
  createReportForTask,
  getLatestReportFiles,
  parseAiResponse,
  parseNextSteps,
} from './core/reports.js';
import {
  type BatonTestRun,
  checkBatonSignature,
  issueRelayBaton,
  loadBaton,
  runTestCommand,
  validateRelayCheck,
  verifyBatonForTask,
} from './core/relay.js';
import { buildPrompt } from './core/prompt.js';
import { detectStack } from './core/stack.js';
import { setupProject } from './core/init.js';
import { callAiWithRetry, callClaudeCode } from './providers.js';

const program = new Command();
const VERSION = '0.8.1';

program
  .name('brothers')
  .description('Brothers Protocol CLI MVP')
  .version(VERSION);

program
  .command('init')
  .description('Initialize Brothers Protocol in current directory or a new directory')
  .argument('[projectName]', 'Optional directory name for initialization')
  .action((projectName?: string) => {
    const root = projectName ? path.resolve(process.cwd(), projectName) : process.cwd();
    fs.mkdirSync(root, { recursive: true });

    if (fs.existsSync(path.join(root, '.brothers-config.json'))) {
      throw new Error(`Project already initialized: ${root}`);
    }

    const effectiveName = projectName || path.basename(root);
    setupProject(root, effectiveName);

    console.log(`Initialized Brothers Protocol project at: ${root}`);
    console.log('Created: coordination/tasks, coordination/reports, coordination/templates, coordination/batons, .brothers-config.json');
    console.log('Baton signing secret: .brothers-secret (added to .gitignore, do not commit)');
  });

const ai = program.command('ai').description('Configure AI provider defaults');

ai
  .command('providers')
  .description('List supported auto providers')
  .action(() => {
    console.log('Supported providers:');
    console.log('- mock         (testing, no API key required)');
    console.log('- claude-code  (uses local Claude Code session, no API key required)');
    console.log('- openai       (requires OPENAI_API_KEY)');
    console.log('- anthropic    (requires ANTHROPIC_API_KEY)');
  });

ai
  .command('show')
  .description('Show AI configuration')
  .action(() => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    console.log('AI CONFIG');
    console.log(`provider: ${config.ai_provider}`);
    console.log(`model: ${config.ai_model || '(default per provider)'}`);
    console.log(`sanitize_prompt: ${config.auto_sanitize_prompt}`);
    console.log(`retries: ${config.ai_retries}`);
    console.log(`retry_delay_ms: ${config.ai_retry_delay_ms}`);
  });

ai
  .command('setup')
  .description('Set AI defaults in .brothers-config.json')
  .option('--provider <provider>', 'manual|mock|openai|anthropic')
  .option('--model <model>', 'Default model for --auto mode')
  .option('--sanitize <mode>', 'on|off')
  .option('--retries <count>', 'Retry count for auto calls')
  .option('--retry-delay-ms <ms>', 'Base retry delay in milliseconds')
  .action((options: { provider?: string; model?: string; sanitize?: string; retries?: string; retryDelayMs?: string }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    if (options.provider) {
      const normalized = options.provider.toLowerCase();
      if (!['manual', 'mock', 'openai', 'anthropic', 'claude', 'claude-code'].includes(normalized)) {
        throw new Error('Unsupported provider. Use manual|mock|openai|anthropic|claude-code');
      }
      config.ai_provider = normalized === 'claude' ? 'anthropic' : normalized;
    }

    if (options.model !== undefined) config.ai_model = options.model;

    if (options.sanitize !== undefined) {
      config.auto_sanitize_prompt = boolFromMode(options.sanitize, config.auto_sanitize_prompt);
    }

    if (options.retries !== undefined) {
      const retries = Number(options.retries);
      if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
        throw new Error('retries must be an integer between 0 and 10');
      }
      config.ai_retries = retries;
    }

    if (options.retryDelayMs !== undefined) {
      const retryDelayMs = Number(options.retryDelayMs);
      if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60000) {
        throw new Error('retry-delay-ms must be an integer between 0 and 60000');
      }
      config.ai_retry_delay_ms = retryDelayMs;
    }

    saveConfig(root, config);

    console.log('AI config updated');
    console.log(`provider: ${config.ai_provider}`);
    console.log(`model: ${config.ai_model || '(default per provider)'}`);
    console.log(`sanitize_prompt: ${config.auto_sanitize_prompt}`);
    console.log(`retries: ${config.ai_retries}`);
    console.log(`retry_delay_ms: ${config.ai_retry_delay_ms}`);
  });

ai
  .command('test')
  .description('Validate AI provider credentials/configuration')
  .option('--provider <provider>', 'manual|mock|openai|anthropic')
  .option('--model <model>', 'Model override for live test')
  .option('--live', 'Make a real API call (openai/anthropic)', false)
  .action(async (options: { provider?: string; model?: string; live: boolean }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    const provider = (options.provider || config.ai_provider || 'manual').toLowerCase();
    const model = options.model || config.ai_model || undefined;

    if (provider === 'manual') {
      throw new Error('AI provider is manual. Set provider via: brothers ai setup --provider mock|openai|anthropic|claude-code');
    }

    if (provider === 'mock') {
      const response = await callAiWithRetry('mock', 'PING', model, 0, 0);
      console.log('AI test passed');
      console.log(`provider: ${provider}`);
      if (model) console.log(`model: ${model}`);
      console.log(`response_size: ${response.length}`);
      return;
    }

    if (provider === 'claude-code') {
      const { spawnSync } = await import('node:child_process');
      const check = spawnSync('claude', ['--version'], { encoding: 'utf-8' });
      if (check.error || check.status !== 0) {
        throw new Error(
          'claude command not found or not working.\n' +
          'Install Claude Code: https://claude.ai/code',
        );
      }
      const version = ((check.stdout as string) || '').trim();
      if (!options.live) {
        console.log('AI test passed (claude command found)');
        console.log('provider: claude-code');
        console.log(`claude version: ${version}`);
        console.log('Use --live to run a real call');
        return;
      }
      const response = await callClaudeCode('Return exactly one word: PONG');
      console.log('AI live test passed');
      console.log('provider: claude-code');
      console.log(`claude version: ${version}`);
      console.log(`response: ${response.slice(0, 100)}`);
      return;
    }

    if (provider === 'openai') {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set');
      }
      if (!options.live) {
        console.log('AI test passed (credentials present)');
        console.log('provider: openai');
        console.log('Use --live to execute an API request');
        return;
      }
    }

    if (provider === 'anthropic' || provider === 'claude') {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is not set');
      }
      if (!options.live) {
        console.log('AI test passed (credentials present)');
        console.log('provider: anthropic');
        console.log('Use --live to execute an API request');
        return;
      }
    }

    const normalizedProvider = provider === 'claude' ? 'anthropic' : provider;
    const response = await callAiWithRetry(normalizedProvider, 'Return exactly: PONG', model, 0, 0);
    console.log('AI live test passed');
    console.log(`provider: ${normalizedProvider}`);
    if (model) console.log(`model: ${model}`);
    console.log(`response_size: ${response.length}`);
  });

program
  .command('task')
  .description('Create a new task')
  .argument('<title>', 'Task title')
  .option('-p, --priority <priority>', 'Task priority', 'medium')
  .option('-a, --assignee <assignee>', 'Task assignee', 'auto')
  .option('-d, --details <details>', 'Task details', '')
  .option('-f, --files <files>', 'Comma/semicolon separated files', '')
  .option('--depends-on <taskIds>', 'Comma/semicolon separated dependencies, e.g. TASK-001,TASK-002', '')
  .action((
    title: string,
    options: { priority: string; assignee: string; details: string; files: string; dependsOn: string },
  ) => {
    const root = findProjectRoot(process.cwd());
    const created = createTask(root, title, {
      priority: options.priority,
      assignee: options.assignee,
      details: options.details,
      files: splitList(options.files),
      dependsOn: splitList(options.dependsOn).map((dep) => dep.toUpperCase()),
    });

    console.log(`Created ${created.id}: ${title}`);
    console.log(`Task file: ${created.taskPath}`);
  });

program
  .command('link')
  .description('Attach dependency links to an existing task')
  .argument('<taskId>', 'Task id, e.g. TASK-002')
  .requiredOption('--depends-on <taskIds>', 'Comma/semicolon separated dependencies')
  .action((taskId: string, options: { dependsOn: string }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const tasksDir = path.join(coordinationRoot(root, config), 'tasks');
    const { taskPath, taskContent } = requireTaskContent(tasksDir, taskId);

    const deps = splitList(options.dependsOn).map((dep) => dep.toUpperCase());

    // Guard: detect circular dependencies before persisting
    for (const dep of deps) {
      const cycle = detectCycles(dep, tasksDir, new Set([taskId.toUpperCase()]), [taskId.toUpperCase()]);
      if (cycle) {
        throw new Error(`Circular dependency detected: ${cycle.join(' → ')}`);
      }
    }

    const updated = replaceDependenciesSection(taskContent, deps);
    writeText(taskPath, updated);

    console.log(`Updated dependencies for ${taskId}`);
    console.log(`Dependencies: ${deps.join(', ') || 'None'}`);
  });

program
  .command('relay-check')
  .description('Validate dependency chain and issue relay baton for a task')
  .argument('<taskId>', 'Task id, e.g. TASK-002')
  .option('--strict', 'Treat warnings as validation errors', false)
  .option('--json', 'Output JSON only', false)
  .option('--run-tests', 'Run the project test command; test result is recorded in the baton', false)
  .option('--test-command <cmd>', 'Override test command for --run-tests (default: config test_command)')
  .action((taskId: string, options: { strict: boolean; json: boolean; runTests: boolean; testCommand?: string }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    const validation = validateRelayCheck(root, config, taskId);
    let warnings = validation.warnings;

    let testRun: BatonTestRun | undefined;
    if (options.runTests) {
      const command = options.testCommand || config.test_command;
      if (!command) {
        throw new Error(
          'No test command configured. Set "test_command" in .brothers-config.json ' +
          'or pass --test-command "npm test"',
        );
      }
      testRun = runTestCommand(root, command);
      if (testRun.exitCode !== 0) {
        const details = testRun.outputTail ? `\n--- output tail ---\n${testRun.outputTail}` : '';
        throw new Error(`Relay validation failed: tests failed (exit ${testRun.exitCode}) for command: ${command}${details}`);
      }
      // Реальный успешный прогон тестов сильнее, чем «в отчёте написано not run»
      warnings = warnings.filter((warning) => !/tests were not executed/.test(warning));
    }

    const strictFailed = options.strict && warnings.length > 0;

    if (options.json) {
      if (strictFailed) {
        console.log(JSON.stringify({
          passed: false,
          strict: options.strict,
          taskId,
          warnings,
        }, null, 2));
        process.exitCode = 1;
        return;
      }

      const issued = issueRelayBaton(root, config, taskId, validation.validatedDeps, testRun);
      console.log(JSON.stringify({
        passed: true,
        strict: options.strict,
        taskId,
        batonId: issued.baton.id,
        batonPath: issued.batonPath,
        testsPassed: testRun ? testRun.exitCode === 0 : undefined,
        warnings,
      }, null, 2));
      return;
    }

    if (strictFailed) {
      throw new Error(`Relay strict mode failed:\n- ${warnings.join('\n- ')}`);
    }

    const issued = issueRelayBaton(root, config, taskId, validation.validatedDeps, testRun);
    console.log(`Relay validation passed for ${taskId}`);
    if (testRun) {
      console.log(`Tests passed: ${testRun.command} (exit 0, ${testRun.durationMs}ms)`);
    }
    console.log(`Baton: ${issued.baton.id}`);
    console.log(`Baton file: ${issued.batonPath}`);
    if (warnings.length > 0) {
      console.log('Warnings:');
      warnings.forEach((warning) => console.log(`- ${warning}`));
    }
  });

program
  .command('baton-info')
  .description('Show relay baton details')
  .argument('<batonId>', 'Baton id, e.g. BATON-001')
  .option('--json', 'Output JSON only', false)
  .action((batonId: string, options: { json: boolean }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const coordination = coordinationRoot(root, config);

    const baton = loadBaton(coordination, batonId);
    const signatureStatus = checkBatonSignature(baton, loadOrCreateSecret(root));

    if (options.json) {
      console.log(JSON.stringify({ ...baton, signatureStatus }, null, 2));
      return;
    }

    const expired = baton.expiresAt && new Date(baton.expiresAt) < new Date();
    console.log(`BATON: ${baton.id}`);
    console.log(`Created:  ${baton.createdAt}`);
    console.log(`Expires:  ${baton.expiresAt ?? 'n/a'}${expired ? ' ⚠ EXPIRED' : ''}`);
    console.log(`To task:  ${baton.toTask}`);
    console.log(`Passed:   ${baton.passed ? 'yes' : 'no'}`);
    console.log(`Signature: ${signatureStatus}${signatureStatus !== 'valid' ? ' ⚠' : ''}`);
    if (baton.testRun) {
      const outcome = baton.testRun.exitCode === 0 ? 'passed' : `failed (exit ${baton.testRun.exitCode})`;
      console.log(`Tests:    ${outcome} — ${baton.testRun.command} @ ${baton.testRun.ranAt}`);
    }
    console.log('Dependencies:');
    for (const dep of baton.dependencies) {
      console.log(`- ${dep.taskId} via ${dep.reportId}`);
    }
  });

program
  .command('prompt')
  .description('Generate task prompt without starting execution')
  .argument('<taskId>', 'Task id, e.g. TASK-001')
  .option('--sanitize <mode>', 'auto|on|off', 'auto')
  .option('--sanitize-preview', 'Show raw and sanitized prompt', false)
  .option('--save', 'Save selected prompt to coordination/prompts', false)
  .action((taskId: string, options: { sanitize: string; sanitizePreview: boolean; save: boolean }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const coordination = coordinationRoot(root, config);
    const tasksDir = path.join(coordination, 'tasks');
    const { taskContent } = requireTaskContent(tasksDir, taskId);

    const built = buildPrompt(root, config, taskId, taskContent);
    const sanitizeEnabled = boolFromMode(options.sanitize, config.auto_sanitize_prompt);
    const selectedPrompt = sanitizeEnabled ? built.sanitizedPrompt : built.rawPrompt;

    if (options.sanitizePreview) {
      console.log('--- RAW PROMPT ---');
      console.log(built.rawPrompt);
      console.log('--- SANITIZED PROMPT ---');
      console.log(built.sanitizedPrompt);
    } else {
      console.log(selectedPrompt);
    }

    if (options.save) {
      const promptPath = path.join(coordination, 'prompts', `${taskId}-prompt.txt`);
      writeText(promptPath, selectedPrompt);
      console.log(`Saved prompt: ${promptPath}`);
    }
  });

program
  .command('start')
  .description('Start task and generate AI prompt')
  .argument('<taskId>', 'Task id, e.g. TASK-001')
  .option('--ai <provider>', 'AI provider name (manual|mock|openai|anthropic)')
  .option('--model <model>', 'Model name for auto mode')
  .option('--with-baton <batonId>', 'Validated baton id, e.g. BATON-001')
  .option('--dry-run', 'Generate prompt only, without status change or AI call', false)
  .option('--auto', 'Automatically send prompt to AI and create report', false)
  .option('--sanitize <mode>', 'auto|on|off', 'auto')
  .option('--retries <count>', 'Override retry count for this run')
  .option('--retry-delay-ms <ms>', 'Override base retry delay for this run')
  .action(async (
    taskId: string,
    options: {
      ai?: string;
      model?: string;
      withBaton?: string;
      dryRun: boolean;
      auto: boolean;
      sanitize: string;
      retries?: string;
      retryDelayMs?: string;
    },
  ) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const coordination = coordinationRoot(root, config);
    const tasksDir = path.join(coordination, 'tasks');

    const { taskPath, taskContent } = requireTaskContent(tasksDir, taskId);

    const dependencies = parseDependencies(taskContent);
    if (dependencies.length > 0) {
      if (!options.withBaton) {
        throw new Error(
          `Task ${taskId} has dependencies (${dependencies.join(', ')}). ` +
          `Run: brothers relay-check ${taskId} and start with --with-baton BATON-XXX`,
        );
      }
      verifyBatonForTask(root, coordination, taskId, dependencies, options.withBaton);
    }

    if (options.dryRun && options.auto) {
      throw new Error('--dry-run cannot be combined with --auto');
    }

    const providerFromConfig = (config.ai_provider || 'manual').toLowerCase();
    const provider = (options.ai || providerFromConfig).toLowerCase();
    const model = options.model
      || (!options.ai || provider === providerFromConfig ? (config.ai_model || undefined) : undefined);

    const built = buildPrompt(root, config, taskId, taskContent);
    const sanitizeEnabled = boolFromMode(options.sanitize, config.auto_sanitize_prompt);
    const prompt = sanitizeEnabled ? built.sanitizedPrompt : built.rawPrompt;

    const promptPath = path.join(coordination, 'prompts', `${taskId}-prompt.txt`);
    writeText(promptPath, prompt);

    if (options.dryRun) {
      console.log(`Task ${taskId} dry-run completed`);
      console.log(`AI provider: ${provider}`);
      if (model) console.log(`Model: ${model}`);
      if (options.withBaton) console.log(`Baton verified: ${options.withBaton}`);
      console.log(`Prompt sanitized: ${sanitizeEnabled}`);
      console.log(`Prompt file: ${promptPath}`);
      console.log('Dry run: task status unchanged, no AI calls executed');
      return;
    }

    updateTaskStatus(taskPath, 'IN_PROGRESS');

    console.log(`Task ${taskId} started`);
    console.log(`AI provider: ${provider}`);
    if (model) console.log(`Model: ${model}`);
    if (options.withBaton) console.log(`Baton verified: ${options.withBaton}`);
    console.log(`Prompt sanitized: ${sanitizeEnabled}`);
    console.log(`Prompt file: ${promptPath}`);

    if (!options.auto) return;

    if (provider === 'manual') {
      throw new Error('Auto mode requires provider mock|openai|anthropic (via --ai or brothers ai setup)');
    }

    const retries = options.retries !== undefined ? Number(options.retries) : config.ai_retries;
    const retryDelayMs = options.retryDelayMs !== undefined ? Number(options.retryDelayMs) : config.ai_retry_delay_ms;
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
      throw new Error('retries must be integer between 0 and 10');
    }
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60000) {
      throw new Error('retry-delay-ms must be integer between 0 and 60000');
    }

    console.log('Auto mode enabled: sending prompt to AI...');
    const aiResponse = await callAiWithRetry(provider, prompt, model, retries, retryDelayMs);

    const responsePath = path.join(coordination, 'prompts', `${taskId}-response.txt`);
    writeText(responsePath, aiResponse);
    console.log(`AI response saved: ${responsePath}`);

    const parsed = parseAiResponse(aiResponse);
    const created = createReportForTask(root, config, taskId, {
      doneItems: parsed.doneItems,
      changedFiles: parsed.changedFiles,
      testsOutput: parsed.testsOutput,
      nextSteps: parsed.nextSteps,
      executor: `${provider}${model ? `:${model}` : ''}`,
      status: parsed.status,
      resultSummary: parsed.resultSummary,
    });

    console.log(`Auto report created: ${created.reportId}`);
    console.log(`Report file: ${created.reportPath}`);
  });

program
  .command('report')
  .description('Create task report and update task status')
  .argument('<taskId>', 'Task id, e.g. TASK-001')
  .option('--done <items>', 'Done items separated by ; or ,', 'Implemented task')
  .option('--files <items>', 'Changed files separated by ; or ,', '')
  .option('--tests <output>', 'Tests output snippet', 'Tests were not run')
  .option('--next <items>', 'Next steps separated by ; or ,', '')
  .option('--executor <executor>', 'Executor name', 'manual')
  .option('--status <status>', 'Task final status', 'COMPLETED')
  .action((
    taskId: string,
    options: { done: string; files: string; tests: string; next: string; executor: string; status: string },
  ) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    const created = createReportForTask(root, config, taskId, {
      doneItems: splitList(options.done),
      changedFiles: splitList(options.files),
      testsOutput: options.tests,
      nextSteps: splitList(options.next),
      executor: options.executor,
      status: normalizeTaskStatus(options.status),
    });

    console.log(`Report created: ${created.reportId}`);
    console.log(`Report file: ${created.reportPath}`);
  });

program
  .command('status')
  .description('Show project task/report status')
  .action(() => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const coordination = coordinationRoot(root, config);

    const tasksDir = path.join(coordination, 'tasks');
    const reportsDir = path.join(coordination, 'reports');
    const batonsDir = path.join(coordination, 'batons');

    const taskFiles = fs.existsSync(tasksDir)
      ? fs.readdirSync(tasksDir).filter((name) => /^TASK-\d+\.md$/.test(name)).sort()
      : [];

    const statuses: Record<TaskStatus, number> = {
      CREATED: 0,
      IN_PROGRESS: 0,
      COMPLETED: 0,
      BLOCKED: 0,
    };

    for (const file of taskFiles) {
      const content = fs.readFileSync(path.join(tasksDir, file), 'utf-8');
      const status = readTaskStatus(content);
      statuses[status] += 1;
    }

    const reportFiles = fs.existsSync(reportsDir)
      ? fs.readdirSync(reportsDir).filter((name) => /^REPORT-\d+\.md$/.test(name)).sort()
      : [];

    const batonFiles = fs.existsSync(batonsDir)
      ? fs.readdirSync(batonsDir).filter((name) => /^BATON-\d+\.json$/.test(name)).sort()
      : [];

    const lastReport = reportFiles.length > 0 ? reportFiles[reportFiles.length - 1] : 'None';

    console.log('BROTHERS STATUS');
    console.log(`Project: ${config.project}`);
    console.log(`Tasks total: ${taskFiles.length}`);
    console.log(`  COMPLETED: ${statuses.COMPLETED}`);
    console.log(`  IN_PROGRESS: ${statuses.IN_PROGRESS}`);
    console.log(`  CREATED: ${statuses.CREATED}`);
    console.log(`  BLOCKED: ${statuses.BLOCKED}`);
    console.log(`Reports total: ${reportFiles.length}`);
    console.log(`Batons total: ${batonFiles.length}`);
    console.log(`Last report: ${lastReport}`);
  });

program
  .command('next')
  .description('Suggest or create the next task from latest report')
  .option('--create <index>', 'Create task by 1-based index from next steps')
  .option('-p, --priority <priority>', 'Priority for auto-created task', 'medium')
  .option('-a, --assignee <assignee>', 'Assignee for auto-created task', 'auto')
  .option('--depends-on <taskIds>', 'Dependencies for auto-created task', '')
  .action((options: { create?: string; priority: string; assignee: string; dependsOn: string }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const reportsDir = path.join(coordinationRoot(root, config), 'reports');
    const latestReportPath = getLatestReportFiles(reportsDir, 1)[0];

    if (!latestReportPath) {
      throw new Error('No reports found. Create at least one report first.');
    }

    const reportContent = fs.readFileSync(latestReportPath, 'utf-8');
    const suggestions = parseNextSteps(reportContent);

    if (suggestions.length === 0) {
      throw new Error('Latest report has no parseable NEXT STEPS section.');
    }

    console.log(`Latest report: ${path.basename(latestReportPath)}`);
    suggestions.forEach((step, idx) => {
      console.log(`${idx + 1}. ${step}`);
    });

    if (options.create) {
      const index = Number(options.create);
      if (!Number.isInteger(index) || index < 1 || index > suggestions.length) {
        throw new Error(`Invalid index: ${options.create}`);
      }

      const created = createTask(root, suggestions[index - 1], {
        priority: options.priority,
        assignee: options.assignee,
        details: `Auto-created from ${path.basename(latestReportPath)} (step ${index})`,
        files: [],
        dependsOn: splitList(options.dependsOn).map((dep) => dep.toUpperCase()),
      });

      console.log(`Created ${created.id}: ${suggestions[index - 1]}`);
    }
  });

program
  .command('stack')
  .description('Detect project tech stack and update .brothers-config.json')
  .option('--show', 'Show current saved stack without re-detecting', false)
  .action((options: { show: boolean }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);

    if (options.show) {
      if (!config.stack?.length) {
        console.log('No stack detected yet. Run: brothers stack');
      } else {
        console.log(`Stack: ${config.stack.join(', ')}`);
        if (config.stack_docs?.length) console.log(`Docs: ${config.stack_docs.join(', ')}`);
        if (config.mcp_suggested?.length) console.log(`Recommended MCP: ${config.mcp_suggested.join(', ')}`);
      }
      return;
    }

    const detected = detectStack(root);
    config.stack         = detected.stack.length > 0 ? detected.stack : undefined;
    config.stack_docs    = detected.docs.length  > 0 ? detected.docs  : undefined;
    config.mcp_suggested = detected.mcp.length   > 0 ? detected.mcp   : undefined;
    saveConfig(root, config);

    if (detected.stack.length === 0) {
      console.log('No stack detected. Place package.json / pyproject.toml / Cargo.toml in project root.');
      return;
    }
    console.log(`Stack detected and saved:`);
    console.log(`  Stack: ${detected.stack.join(', ')}`);
    if (detected.docs.length)  console.log(`  Docs:  ${detected.docs.join('\n         ')}`);
    if (detected.mcp.length)   console.log(`  MCP:   ${detected.mcp.join('\n         ')}`);
  });

program
  .command('context')
  .description('Generate AI context prompt for a task without changing its status')
  .argument('<taskId>', 'Task id, e.g. TASK-001')
  .option('--sanitize <mode>', 'auto|on|off — whether to remove sensitive data', 'auto')
  .action((taskId: string, options: { sanitize: string }) => {
    const root = findProjectRoot(process.cwd());
    const config = loadConfig(root);
    const coordination = coordinationRoot(root, config);
    const tasksDir = path.join(coordination, 'tasks');

    const taskFile = path.join(tasksDir, `${taskId}.md`);
    if (!fs.existsSync(taskFile)) throw new Error(`Task not found: ${taskId}`);
    const taskContent = fs.readFileSync(taskFile, 'utf-8');

    const built = buildPrompt(root, config, taskId, taskContent);
    const sanitizeEnabled = boolFromMode(options.sanitize, config.auto_sanitize_prompt);
    const prompt = sanitizeEnabled ? built.sanitizedPrompt : built.rawPrompt;

    const promptPath = path.join(coordination, 'prompts', `${taskId}-prompt.txt`);
    writeText(promptPath, prompt);

    console.log(`Context generated for ${taskId}`);
    if (config.stack?.length) console.log(`Stack: ${config.stack.join(', ')}`);
    if (config.stack_docs?.length) console.log(`Docs: ${config.stack_docs.join(', ')}`);
    if (config.mcp_suggested?.length) console.log(`Recommended MCP: ${config.mcp_suggested.join(', ')}`);
    console.log(`Characters: ${prompt.length}`);
    console.log(`Prompt file: ${promptPath}`);
  });

program
  .command('ui')
  .description('Launch interactive TUI dashboard')
  .action(async () => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath: ftu } = await import('node:url');
    const tuiPath = path.join(path.dirname(ftu(import.meta.url)), 'tui', 'index.js');
    if (!fs.existsSync(tuiPath)) {
      console.error('TUI not built. Run: npm run build');
      process.exit(1);
    }
    const child = spawn(process.execPath, [tuiPath], { stdio: 'inherit' });
    child.on('exit', code => process.exit(code ?? 0));
  });

process.on('uncaughtException', (err) => {
  console.error(err.message);
  process.exit(1);
});

program.parseAsync(process.argv);
