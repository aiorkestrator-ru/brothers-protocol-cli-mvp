import fs from 'node:fs';
import path from 'node:path';
import { checkBatonSignature, type RelayBaton } from '../core/relay.js';

export type TaskStatus = 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: string;
  assignee: string;
  dependencies: string[];
  files: string[];
}

export interface BatonTestRunView {
  command: string;
  exitCode: number;
  ranAt: string;
}

export interface Baton {
  id: string;
  toTask: string;
  passed: boolean;
  expiresAt?: string;
  createdAt: string;
  signature?: string;
  testRun?: BatonTestRunView;
}

export function findCoordDir(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'coordination');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function readTasks(coordDir: string): Task[] {
  const tasksDir = path.join(coordDir, 'tasks');
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir)
    .filter(f => /^TASK-\d+\.md$/.test(f))
    .sort()
    .map(file => {
      const content = fs.readFileSync(path.join(tasksDir, file), 'utf-8');
      return parseTask(file.replace('.md', ''), content);
    });
}

function parseTask(id: string, content: string): Task {
  const titleMatch = content.match(/^# (?:TASK-\d+:?\s*)(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : id;

  const statusMatch = content.match(/\*Status:\s*(\w+)\*/);
  const status = (statusMatch?.[1] as TaskStatus) ?? 'CREATED';

  const priorityMatch = content.match(/^## Priority\s*\n([^\n]+)/m);
  const priority = priorityMatch ? priorityMatch[1].trim() : 'medium';

  const assigneeMatch = content.match(/^## Assignee\s*\n([^\n]+)/m);
  const assignee = assigneeMatch ? assigneeMatch[1].trim() : '';

  const depsSection = content.match(/^## Dependencies\s*\n([\s\S]*?)(?=\n##|\s*$)/m);
  const dependencies: string[] = [];
  if (depsSection) {
    for (const m of depsSection[1].matchAll(/TASK-\d+/g)) dependencies.push(m[0]);
  }

  const filesMatch = content.match(/^## Files\s*\n([^\n]+)/m);
  const files = filesMatch
    ? filesMatch[1].split(',').map(f => f.trim()).filter(Boolean)
    : [];

  return { id, title, status, priority, assignee, dependencies, files };
}

export function readBatons(coordDir: string): Baton[] {
  const batonsDir = path.join(coordDir, 'batons');
  if (!fs.existsSync(batonsDir)) return [];
  return fs
    .readdirSync(batonsDir)
    .filter(f => /^BATON-\d+\.json$/.test(f))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(batonsDir, f), 'utf-8')) as Baton;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Baton[];
}

interface BrothersConfig {
  project?: string;
  stack?: string[];
  stack_docs?: string[];
  mcp_suggested?: string[];
}

function readConfig(coordDir: string): BrothersConfig {
  try {
    const cfgPath = path.join(path.dirname(coordDir), '.brothers-config.json');
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as BrothersConfig;
  } catch {
    return {};
  }
}

export function getProjectName(coordDir: string): string {
  const cfg = readConfig(coordDir);
  return cfg.project || path.basename(path.dirname(coordDir));
}

export function getProjectStack(coordDir: string): string[] {
  return readConfig(coordDir).stack ?? [];
}

export function getMcpSuggested(coordDir: string): string[] {
  return readConfig(coordDir).mcp_suggested ?? [];
}

export type BatonSignatureView = 'valid' | 'invalid' | 'missing' | 'no-secret';

/** Статус подписи батона для TUI: no-secret = секрет проекта недоступен, проверить нельзя. */
export function batonSignatureStatus(coordDir: string, baton: Baton): BatonSignatureView {
  const secretPath = path.join(path.dirname(coordDir), '.brothers-secret');
  if (!fs.existsSync(secretPath)) return 'no-secret';
  const secret = fs.readFileSync(secretPath, 'utf-8').trim();
  return checkBatonSignature(baton as unknown as RelayBaton, secret);
}

export function isBatonActive(baton: Baton): boolean {
  return baton.passed && (!baton.expiresAt || new Date(baton.expiresAt) > new Date());
}

export function isBatonExpired(baton: Baton): boolean {
  return baton.passed && !!baton.expiresAt && new Date(baton.expiresAt) <= new Date();
}
