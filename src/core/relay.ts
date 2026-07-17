import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ensureDir, nowIso, nextEntityId, writeText } from './fsutil.js';
import { type Config, coordinationRoot, loadOrCreateSecret } from './config.js';
import { detectCycles, extractSection, getTaskPath, parseDependencies, readTaskStatus, requireTaskContent } from './tasks.js';
import { findLatestReportForTask, parseChangedFiles, validateReportStructure } from './reports.js';

export type RelayDependencyValidation = {
  taskId: string;
  reportId: string;
  artifactsChecked: string[];
  warnings: string[];
};

export type BatonTestRun = {
  command: string;
  exitCode: number;
  ranAt: string;
  durationMs: number;
  outputTail: string;
};

export type RelayBaton = {
  id: string;
  createdAt: string;
  expiresAt: string;
  toTask: string;
  dependencies: RelayDependencyValidation[];
  checks: string[];
  passed: boolean;
  testRun?: BatonTestRun;
  signature?: string; // HMAC-SHA256 от содержимого батона (см. signBatonPayload)
};

/**
 * Детерминированная сериализация: ключи объектов сортируются рекурсивно,
 * чтобы подпись не зависела от порядка ключей в JSON-файле.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export function signBatonPayload(baton: Omit<RelayBaton, 'signature'>, secret: string): string {
  return crypto.createHmac('sha256', secret).update(stableStringify(baton)).digest('hex');
}

export type BatonSignatureStatus = 'valid' | 'invalid' | 'missing';

export function checkBatonSignature(baton: RelayBaton, secret: string): BatonSignatureStatus {
  if (!baton.signature) return 'missing';
  const { signature, ...payload } = baton;
  const expected = signBatonPayload(payload, secret);
  const a = Buffer.from(signature, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return 'valid';
  return 'invalid';
}

/** Запускает команду тестов проекта; возвращает результат для записи в baton. */
export function runTestCommand(root: string, command: string): BatonTestRun {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });

  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const tail = combined.split('\n').slice(-25).join('\n');
  const exitCode = result.status ?? (result.signal ? 1 : 0);

  return {
    command,
    exitCode,
    ranAt: nowIso(),
    durationMs: Date.now() - startedAt,
    outputTail: tail,
  };
}

export function validateRelayCheck(
  root: string,
  config: Config,
  taskId: string,
): { warnings: string[]; validatedDeps: RelayDependencyValidation[] } {
  const coordination = coordinationRoot(root, config);
  const tasksDir = path.join(coordination, 'tasks');
  const reportsDir = path.join(coordination, 'reports');

  const { taskContent } = requireTaskContent(tasksDir, taskId);
  const dependencies = parseDependencies(taskContent);

  if (dependencies.length === 0) {
    throw new Error(`Task ${taskId} has no dependencies. Relay check is not required.`);
  }

  // Safety net: reject relay-check if someone manually introduced a cycle
  for (const dep of dependencies) {
    const cycle = detectCycles(dep, tasksDir, new Set([taskId]), [taskId]);
    if (cycle) {
      throw new Error(`Circular dependency detected: ${cycle.join(' → ')}. Fix dependencies before relay-check.`);
    }
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const validatedDeps: RelayDependencyValidation[] = [];

  for (const dep of dependencies) {
    const depTaskPath = getTaskPath(tasksDir, dep);
    if (!fs.existsSync(depTaskPath)) {
      errors.push(`${dep}: task file is missing`);
      continue;
    }

    const depTaskContent = fs.readFileSync(depTaskPath, 'utf-8');
    const depStatus = readTaskStatus(depTaskContent);
    if (depStatus !== 'COMPLETED') {
      errors.push(`${dep}: status is ${depStatus}, expected COMPLETED`);
      continue;
    }

    const report = findLatestReportForTask(reportsDir, dep);
    if (!report) {
      errors.push(`${dep}: report not found`);
      continue;
    }

    const missingSections = validateReportStructure(report.reportContent);
    if (missingSections.length > 0) {
      errors.push(`${dep}: report ${report.reportId} missing sections ${missingSections.join(', ')}`);
      continue;
    }

    const changedFiles = parseChangedFiles(report.reportContent);
    const missingFiles = changedFiles.filter((file) => !fs.existsSync(path.resolve(root, file)));
    if (missingFiles.length > 0) {
      errors.push(`${dep}: missing artifacts ${missingFiles.join(', ')}`);
      continue;
    }

    const testsSection = extractSection(report.reportContent, 'TESTS');
    if (/not run|not executed|не запуск/i.test(testsSection)) {
      warnings.push(`${dep}: tests were not executed according to ${report.reportId}`);
    }

    validatedDeps.push({
      taskId: dep,
      reportId: report.reportId,
      artifactsChecked: changedFiles,
      warnings: [],
    });
  }

  if (errors.length > 0) {
    throw new Error(`Relay validation failed:\n- ${errors.join('\n- ')}`);
  }

  return { warnings, validatedDeps };
}

export function issueRelayBaton(
  root: string,
  config: Config,
  taskId: string,
  validatedDeps: RelayDependencyValidation[],
  testRun?: BatonTestRun,
): { baton: RelayBaton; batonPath: string } {
  const coordination = coordinationRoot(root, config);
  const batonsDir = path.join(coordination, 'batons');

  ensureDir(batonsDir);

  const batonId = nextEntityId(batonsDir, 'BATON', '.json');
  const ttlHours = config.baton_ttl_hours ?? 72;
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  const checks = ['dependencies_completed', 'reports_exist', 'report_sections_valid', 'artifacts_exist'];
  if (testRun && testRun.exitCode === 0) checks.push('tests_passed');
  checks.push('baton_signed');

  const payload: Omit<RelayBaton, 'signature'> = {
    id: batonId,
    createdAt: nowIso(),
    expiresAt,
    toTask: taskId,
    dependencies: validatedDeps,
    checks,
    passed: true,
    ...(testRun ? { testRun } : {}),
  };

  const secret = loadOrCreateSecret(root);
  const baton: RelayBaton = { ...payload, signature: signBatonPayload(payload, secret) };

  const batonPath = path.join(batonsDir, `${batonId}.json`);
  writeText(batonPath, `${JSON.stringify(baton, null, 2)}\n`);

  return { baton, batonPath };
}

export function loadBaton(coordination: string, batonId: string): RelayBaton {
  const batonPath = path.join(coordination, 'batons', `${batonId}.json`);
  if (!fs.existsSync(batonPath)) {
    throw new Error(`Baton not found: ${batonId}`);
  }
  return JSON.parse(fs.readFileSync(batonPath, 'utf-8')) as RelayBaton;
}

export function verifyBatonForTask(
  root: string,
  coordination: string,
  taskId: string,
  dependencies: string[],
  batonId: string,
): RelayBaton {
  const baton = loadBaton(coordination, batonId);

  const secret = loadOrCreateSecret(root);
  const signatureStatus = checkBatonSignature(baton, secret);
  if (signatureStatus === 'missing') {
    throw new Error(
      `Baton ${batonId} has no signature (issued by an older version or crafted by hand). ` +
      `Run: brothers relay-check ${taskId} to issue a signed baton.`,
    );
  }
  if (signatureStatus === 'invalid') {
    throw new Error(
      `Baton ${batonId} signature is INVALID — the baton was edited or forged. ` +
      `Run: brothers relay-check ${taskId} to issue a fresh baton.`,
    );
  }

  if (!baton.passed) throw new Error(`Baton ${batonId} is not passed`);
  if (baton.expiresAt && new Date(baton.expiresAt) < new Date()) {
    throw new Error(
      `Baton ${batonId} expired at ${baton.expiresAt}. Run: brothers relay-check ${taskId} to issue a fresh baton.`,
    );
  }
  if (baton.toTask !== taskId) throw new Error(`Baton ${batonId} is for ${baton.toTask}, not ${taskId}`);

  const batonDeps = baton.dependencies.map((dep) => dep.taskId).sort();
  const taskDeps = [...dependencies].sort();
  if (JSON.stringify(batonDeps) !== JSON.stringify(taskDeps)) {
    throw new Error(`Baton ${batonId} does not match current dependencies for ${taskId}`);
  }

  return baton;
}
