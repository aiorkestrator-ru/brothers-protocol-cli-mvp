import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, 'dist', 'cli.js');

function runResult(args, cwd, env = {}) {
  return spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function run(args, cwd, env = {}) {
  const result = runResult(args, cwd, env);
  if (result.status !== 0) {
    throw new Error(
      `Command failed: node ${cliPath} ${args.join(' ')}\n` +
      `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function runFail(args, cwd, env = {}) {
  const result = runResult(args, cwd, env);
  assert.notEqual(result.status, 0, `Expected command to fail: ${args.join(' ')}`);
  return `${result.stdout}\n${result.stderr}`;
}

/** init + TASK-001 completed with report + TASK-002 depends on TASK-001 */
function setupRelayProject() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brothers-sec-'));
  run(['init'], tempRoot);
  run(['task', 'Base task', '--files', 'artifact.txt'], tempRoot);
  fs.writeFileSync(path.join(tempRoot, 'artifact.txt'), 'ok\n');
  run(['start', 'TASK-001'], tempRoot);
  run([
    'report', 'TASK-001',
    '--done', 'Base work',
    '--files', 'artifact.txt',
    '--tests', 'PASS unit',
    '--next', 'Dependent task',
  ], tempRoot);
  run(['task', 'Dependent task', '--depends-on', 'TASK-001'], tempRoot);
  return tempRoot;
}

test('Baton is HMAC-signed and secret is gitignored', () => {
  const tempRoot = setupRelayProject();

  run(['relay-check', 'TASK-002'], tempRoot);

  const batonPath = path.join(tempRoot, 'coordination', 'batons', 'BATON-001.json');
  const baton = JSON.parse(fs.readFileSync(batonPath, 'utf-8'));
  assert.match(baton.signature ?? '', /^[0-9a-f]{64}$/, 'baton must carry hex HMAC signature');
  assert.ok(baton.checks.includes('baton_signed'));

  assert.ok(fs.existsSync(path.join(tempRoot, '.brothers-secret')), 'secret file must exist');
  const gitignore = fs.readFileSync(path.join(tempRoot, '.gitignore'), 'utf-8');
  assert.match(gitignore, /\.brothers-secret/, 'secret must be gitignored');

  const infoJson = JSON.parse(run(['baton-info', 'BATON-001', '--json'], tempRoot));
  assert.equal(infoJson.signatureStatus, 'valid');

  run(['start', 'TASK-002', '--with-baton', 'BATON-001'], tempRoot);
});

test('Tampered baton is rejected, unsigned baton is rejected', () => {
  const tempRoot = setupRelayProject();
  run(['relay-check', 'TASK-002'], tempRoot);

  const batonPath = path.join(tempRoot, 'coordination', 'batons', 'BATON-001.json');
  const baton = JSON.parse(fs.readFileSync(batonPath, 'utf-8'));

  // Подмена содержимого при сохранении старой подписи
  const tampered = { ...baton, expiresAt: '2099-01-01 00:00:00' };
  fs.writeFileSync(batonPath, JSON.stringify(tampered, null, 2));
  const tamperOut = runFail(['start', 'TASK-002', '--with-baton', 'BATON-001'], tempRoot);
  assert.match(tamperOut, /signature is INVALID/i);

  // Рукописный baton без подписи вообще
  const forged = { ...baton };
  delete forged.signature;
  fs.writeFileSync(batonPath, JSON.stringify(forged, null, 2));
  const forgeOut = runFail(['start', 'TASK-002', '--with-baton', 'BATON-001'], tempRoot);
  assert.match(forgeOut, /has no signature/i);
});

test('relay-check --run-tests records passing run and clears not-run warning', () => {
  const tempRoot = setupRelayProject();

  // Отчёт с "Tests were not run" → в обычном strict-режиме был бы warning
  run([
    'report', 'TASK-001',
    '--done', 'More work',
    '--files', 'artifact.txt',
    '--tests', 'Tests were not run',
    '--next', 'Continue',
  ], tempRoot);

  const passOut = run([
    'relay-check', 'TASK-002', '--strict', '--run-tests',
    '--test-command', 'node -e "process.exit(0)"',
  ], tempRoot);
  assert.match(passOut, /Tests passed/);

  const baton = JSON.parse(
    fs.readFileSync(path.join(tempRoot, 'coordination', 'batons', 'BATON-001.json'), 'utf-8'),
  );
  assert.ok(baton.checks.includes('tests_passed'));
  assert.equal(baton.testRun.exitCode, 0);
  assert.equal(baton.testRun.command, 'node -e "process.exit(0)"');
});

test('relay-check --run-tests fails on failing test command and issues no baton', () => {
  const tempRoot = setupRelayProject();

  const failOut = runFail([
    'relay-check', 'TASK-002', '--run-tests',
    '--test-command', 'node -e "console.error(1); process.exit(3)"',
  ], tempRoot);
  assert.match(failOut, /tests failed \(exit 3\)/i);

  const batonsDir = path.join(tempRoot, 'coordination', 'batons');
  const batons = fs.readdirSync(batonsDir).filter((f) => f.endsWith('.json'));
  assert.equal(batons.length, 0, 'no baton must be issued when tests fail');
});

test('relay-check --run-tests without configured command explains how to fix', () => {
  const tempRoot = setupRelayProject();
  const out = runFail(['relay-check', 'TASK-002', '--run-tests'], tempRoot);
  assert.match(out, /No test command configured/i);
});
