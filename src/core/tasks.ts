import fs from 'node:fs';
import path from 'node:path';
import { nowIso, nextEntityId, writeText } from './fsutil.js';
import { type Config, coordinationRoot, loadConfig } from './config.js';

export type TaskStatus = 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED';

export function normalizeTaskStatus(value: string | undefined): TaskStatus {
  const upper = (value ?? '').toUpperCase();
  if (upper === 'CREATED' || upper === 'IN_PROGRESS' || upper === 'COMPLETED' || upper === 'BLOCKED') {
    return upper;
  }
  return 'COMPLETED';
}

export function updateTaskStatus(taskPath: string, status: TaskStatus): void {
  const content = fs.readFileSync(taskPath, 'utf-8');
  const updated = content.replace(/\*Status:\s*[^*]+\*/g, `*Status: ${status}*`);
  fs.writeFileSync(taskPath, updated, 'utf-8');
}

export function readTaskStatus(content: string): TaskStatus {
  const match = content.match(/\*Status:\s*([A-Z_]+)\*/);
  return normalizeTaskStatus(match?.[1]);
}

export function extractSection(content: string, sectionTitle: string): string {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`##\\s+${escaped}([\\s\\S]*?)(\\n##\\s+|$)`, 'i');
  const match = content.match(matcher);
  return match?.[1]?.trim() ?? '';
}

export function extractAnySection(content: string, sectionTitles: string[]): string {
  for (const title of sectionTitles) {
    const section = extractSection(content, title);
    if (section) return section;
  }
  return '';
}

export function parseChecklistItems(section: string): string[] {
  if (!section) return [];
  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const items: string[] = [];
  for (const line of lines) {
    const checklist = line.match(/^[-*]\s*(?:✅|\[x\]|\[X\])\s*(.+)$/);
    const bullet = line.match(/^[-*]\s*(?:\[\s\]|\[x\]|\[X\])?\s*(.+)$/);
    const numeric = line.match(/^\d+\.\s+(.+)$/);
    if (checklist) items.push(checklist[1].trim());
    else if (bullet) items.push(bullet[1].trim());
    else if (numeric) items.push(numeric[1].trim());
  }

  return Array.from(new Set(items));
}

export function parseDependencies(taskContent: string): string[] {
  const section = extractSection(taskContent, 'Dependencies');
  if (!section) return [];

  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const deps: string[] = [];
  for (const line of lines) {
    if (/^none$/i.test(line)) continue;
    const bullet = line.match(/^[-*]\s*(.+)$/);
    const value = bullet ? bullet[1].trim() : line;
    if (/^TASK-\d+$/i.test(value)) deps.push(value.toUpperCase());
  }

  return Array.from(new Set(deps));
}

/**
 * DFS cycle detection in the task dependency graph.
 * Returns the cycle path (e.g. ["TASK-001","TASK-003","TASK-001"]) or null if no cycle.
 * Uses a recursion stack (recStack) to distinguish back-edges from cross-edges.
 */
export function detectCycles(
  startId: string,
  tasksDir: string,
  visited: Set<string> = new Set(),
  recStack: string[] = [],
): string[] | null {
  if (recStack.includes(startId)) {
    // Found a back-edge → cycle. Return path from first occurrence to current.
    return [...recStack.slice(recStack.indexOf(startId)), startId];
  }
  if (visited.has(startId)) return null; // already fully explored, no cycle through here
  visited.add(startId);

  const taskFile = path.join(tasksDir, `${startId}.md`);
  if (!fs.existsSync(taskFile)) return null; // task doesn't exist yet, skip

  const content = fs.readFileSync(taskFile, 'utf-8');
  const deps = parseDependencies(content);

  for (const dep of deps) {
    const cycle = detectCycles(dep, tasksDir, visited, [...recStack, startId]);
    if (cycle) return cycle;
  }

  return null;
}

export function replaceDependenciesSection(taskContent: string, dependencies: string[]): string {
  const depsBlock = dependencies.length > 0 ? dependencies.map((dep) => `- ${dep}`).join('\n') : 'None';
  const matcher = /##\s+Dependencies[\s\S]*?(\n##\s+|\n---|$)/i;

  if (matcher.test(taskContent)) {
    return taskContent.replace(matcher, `## Dependencies\n${depsBlock}\n\n$1`);
  }

  const marker = '\n## Done Criteria';
  const insertion = `\n## Dependencies\n${depsBlock}\n`;
  if (taskContent.includes(marker)) {
    return taskContent.replace(marker, `${insertion}${marker}`);
  }

  return `${taskContent.trim()}\n\n## Dependencies\n${depsBlock}\n`;
}

export function renderTaskMarkdown(
  id: string,
  title: string,
  priority: string,
  assignee: string,
  details: string,
  files: string[],
  dependencies: string[],
): string {
  const filesList = files.length > 0 ? files.map((file) => `- ${file}`).join('\n') : 'None';
  const depsList = dependencies.length > 0 ? dependencies.map((dep) => `- ${dep}`).join('\n') : 'None';

  return `# ${id}: ${title}

## Description
${title}

## Created
${nowIso()}

## Assignee
${assignee}

## Priority
${priority}

## Details
${details || '[Fill details]'}

## Dependencies
${depsList}

## Done Criteria
- [ ] Code works
- [ ] Tests pass
- [ ] Documentation updated

## Files
${filesList}

---
*Status: CREATED*
*Next: Run brothers start ${id}*
`;
}

export function extractTaskTitle(taskContent: string): string {
  const firstLine = taskContent.split('\n').find((line) => line.startsWith('# '));
  if (!firstLine) return 'Untitled task';
  return firstLine.replace(/^#\s+[^:]+:\s*/, '').trim();
}

export function getTaskPath(tasksDir: string, taskId: string): string {
  return path.join(tasksDir, `${taskId}.md`);
}

export function requireTaskContent(tasksDir: string, taskId: string): { taskPath: string; taskContent: string } {
  const taskPath = getTaskPath(tasksDir, taskId);
  if (!fs.existsSync(taskPath)) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return { taskPath, taskContent: fs.readFileSync(taskPath, 'utf-8') };
}

export function createTask(
  root: string,
  title: string,
  options: { priority: string; assignee: string; details: string; files: string[]; dependsOn: string[] },
): { id: string; taskPath: string } {
  const config: Config = loadConfig(root);
  const coordination = coordinationRoot(root, config);
  const tasksDir = path.join(coordination, 'tasks');

  const id = nextEntityId(tasksDir, config.task_prefix);

  // Guard: detect cycles before writing. Since `id` doesn't exist yet,
  // a cycle would only occur if any existing dep already (transitively) points
  // back to a task with the same id — practically impossible, but safe to check.
  for (const dep of options.dependsOn) {
    const cycle = detectCycles(dep, tasksDir, new Set([id]), [id]);
    if (cycle) {
      // Remove the placeholder created by nextEntityId before throwing
      const placeholder = path.join(tasksDir, `${id}.md`);
      if (fs.existsSync(placeholder)) fs.unlinkSync(placeholder);
      throw new Error(`Circular dependency detected: ${cycle.join(' → ')}`);
    }
  }

  const taskPath = path.join(tasksDir, `${id}.md`);
  const content = renderTaskMarkdown(
    id,
    title,
    options.priority,
    options.assignee,
    options.details,
    options.files,
    options.dependsOn,
  );

  writeText(taskPath, content);
  return { id, taskPath };
}
