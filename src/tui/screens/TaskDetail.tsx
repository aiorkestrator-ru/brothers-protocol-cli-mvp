import React from 'react';
import fs from 'node:fs';
import { Box, Text, useInput, useApp } from 'ink';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Badge } from '../components/Badge.js';
import { StatusBar } from '../components/StatusBar.js';
import type { Task, Baton } from '../lib.js';
import { batonSignatureStatus, isBatonActive, isBatonExpired } from '../lib.js';

// dist/tui/screens/TaskDetail.js → dist/tui/ → dist/
const _distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Props {
  task: Task;
  batons: Baton[];
  coordDir: string;
  onBack: () => void;
  onOutput: (command: string, output: string) => void;
}

function runCli(args: string, cwd: string): string {
  const cliPath = path.join(_distDir, 'cli.js');
  try {
    return execSync(`node "${cliPath}" ${args}`, { encoding: 'utf-8', cwd, timeout: 15000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return (err.stdout ?? '') + (err.stderr ? `\nError: ${err.stderr}` : (err.message ?? ''));
  }
}

function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === 'darwin') {
      execSync('pbcopy', { input: text, timeout: 3000 });
    } else if (process.platform === 'win32') {
      execSync('clip', { input: text, timeout: 3000 });
    } else {
      try {
        execSync('xclip -selection clipboard', { input: text, timeout: 3000 });
      } catch {
        execSync('xsel --clipboard --input', { input: text, timeout: 3000 });
      }
    }
    return true;
  } catch {
    return false;
  }
}

const PRIORITY_COLOR: Record<string, string> = {
  high: 'red',
  medium: 'yellow',
  low: 'gray',
};

export function TaskDetail({ task, batons, coordDir, onBack, onOutput }: Props) {
  const { exit } = useApp();
  const projectDir = path.dirname(coordDir);

  const activeBaton = batons.find(b => b.toTask === task.id && isBatonActive(b));
  const expiredBaton = batons.find(b => b.toTask === task.id && isBatonExpired(b));

  const hasDeps  = task.dependencies.length > 0;
  const canStart = task.status === 'CREATED' && (!hasDeps || !!activeBaton);
  const canDone  = task.status === 'IN_PROGRESS';
  const canRelay = hasDeps;

  useInput((input, key) => {
    if (key.escape || input === 'b' || input === 'B') { onBack(); return; }

    if ((input === 's' || input === 'S') && canStart) {
      const batonArg = activeBaton ? ` --with-baton ${activeBaton.id}` : '';
      const output = runCli(`start ${task.id}${batonArg}`, projectDir);
      onOutput(`start ${task.id}`, output);
      return;
    }

    if ((input === 'd' || input === 'D') && canDone) {
      const output = runCli(`report ${task.id} --done "Завершено" --executor "manual"`, projectDir);
      onOutput(`report ${task.id}`, output);
      return;
    }

    if ((input === 'c' || input === 'C') && canRelay) {
      const output = runCli(`relay-check ${task.id}`, projectDir);
      onOutput(`relay-check ${task.id}`, output);
      return;
    }

    if (input === 'x' || input === 'X') {
      const genOutput = runCli(`context ${task.id}`, projectDir);
      const match = genOutput.match(/Prompt file: (.+)/);
      if (match) {
        const promptPath = match[1]!.trim();
        try {
          const promptText = fs.readFileSync(promptPath, 'utf-8');
          const ok = copyToClipboard(promptText);
          onOutput(`context ${task.id}`, ok
            ? `${genOutput}\n✓ Контекст скопирован в буфер обмена (${promptText.length} символов)`
            : `${genOutput}\n⚠ Clipboard недоступен. Файл сохранён:\n${promptPath}`);
        } catch {
          onOutput(`context ${task.id}`, genOutput);
        }
      } else {
        onOutput(`context ${task.id}`, genOutput);
      }
      return;
    }

    if (input === 'q' || input === 'Q') exit();
  });

  return (
    <Box flexDirection="column">
      <Box borderStyle="double" borderColor="cyan" paddingX={2}>
        <Text bold color="cyan">{task.id}</Text>
        <Text bold>{'  '}{task.title}</Text>
      </Box>

      <Box flexDirection="column" paddingX={3} paddingY={1} gap={0}>
        <Row label="Статус">
          <Badge status={task.status} />
          <Text color={
            task.status === 'COMPLETED'   ? 'green'  :
            task.status === 'IN_PROGRESS' ? 'yellow' :
            task.status === 'BLOCKED'     ? 'red'    : 'gray'
          }>{' '}{task.status}</Text>
        </Row>

        <Row label="Приоритет">
          <Text color={(PRIORITY_COLOR[task.priority] ?? 'white') as Parameters<typeof Text>[0]['color']}>
            {task.priority}
          </Text>
        </Row>

        {task.assignee && task.assignee !== '-' && (
          <Row label="Исполнитель"><Text>{task.assignee}</Text></Row>
        )}

        {task.dependencies.length > 0 && (
          <Row label="Зависит от"><Text color="cyan">{task.dependencies.join(', ')}</Text></Row>
        )}

        {task.files.length > 0 && (
          <Row label="Файлы"><Text dimColor>{task.files.join(', ')}</Text></Row>
        )}

        {activeBaton && (
          <Box marginTop={1} flexDirection="column">
            <Box gap={1}>
              <Text color="green">⚡ Baton {activeBaton.id} активен</Text>
              {activeBaton.expiresAt && (
                <Text color="gray">(истекает {activeBaton.expiresAt})</Text>
              )}
              <BatonSignature baton={activeBaton} coordDir={coordDir} />
            </Box>
            {activeBaton.testRun && (
              <Box>
                <Text color={activeBaton.testRun.exitCode === 0 ? 'green' : 'red'}>
                  {activeBaton.testRun.exitCode === 0 ? '  ✓ тесты прошли' : `  ✗ тесты упали (exit ${activeBaton.testRun.exitCode})`}
                </Text>
                <Text color="gray"> — {activeBaton.testRun.command} @ {activeBaton.testRun.ranAt}</Text>
              </Box>
            )}
          </Box>
        )}
        {expiredBaton && !activeBaton && (
          <Box marginTop={1}>
            <Text color="red">⚠  Baton истёк. Запусти </Text>
            <Text bold color="cyan">[C]</Text>
            <Text color="red"> для обновления.</Text>
          </Box>
        )}
        {!activeBaton && !expiredBaton && hasDeps && (
          <Box marginTop={1}>
            <Text color="gray">Нет активного baton — нажми </Text>
            <Text bold color="cyan">[C]</Text>
            <Text color="gray"> чтобы проверить зависимости.</Text>
          </Box>
        )}
        {hasDeps && !activeBaton && task.status === 'CREATED' && (
          <Box>
            <Text color="gray" dimColor>  [S] недоступен — сначала разблокируй [C]</Text>
          </Box>
        )}
      </Box>

      <StatusBar hints={[
        ...(canStart ? [{ key: 'S', label: 'начать' }] : []),
        ...(canDone  ? [{ key: 'D', label: 'завершить' }] : []),
        ...(canRelay ? [{ key: 'C', label: 'разблокировать' }] : []),
        { key: 'X',     label: 'контекст' },
        { key: 'Esc/B', label: 'назад' },
        { key: 'Q',     label: 'выход' },
      ]} />
    </Box>
  );
}

function BatonSignature({ baton, coordDir }: { baton: Baton; coordDir: string }) {
  const status = batonSignatureStatus(coordDir, baton);
  if (status === 'valid')     return <Text color="green">✓ подписан</Text>;
  if (status === 'invalid')   return <Text color="red" bold>✗ ПОДПИСЬ НЕВАЛИДНА</Text>;
  if (status === 'missing')   return <Text color="yellow">⚠ без подписи</Text>;
  return <Text color="gray" dimColor>подпись не проверить (нет секрета)</Text>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box gap={1} marginBottom={0}>
      <Text color="gray" dimColor>{label.padEnd(14)}</Text>
      {children}
    </Box>
  );
}
