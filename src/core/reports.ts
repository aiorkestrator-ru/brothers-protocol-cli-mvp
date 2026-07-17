import fs from 'node:fs';
import path from 'node:path';
import { nowIso, writeText, nextEntityId } from './fsutil.js';
import { type Config, coordinationRoot } from './config.js';
import {
  type TaskStatus,
  extractAnySection,
  extractSection,
  extractTaskTitle,
  normalizeTaskStatus,
  parseChecklistItems,
  requireTaskContent,
  updateTaskStatus,
} from './tasks.js';

export type ParsedAiReport = {
  status: TaskStatus;
  doneItems: string[];
  changedFiles: string[];
  testsOutput: string;
  nextSteps: string[];
  resultSummary: string;
};

export function getLatestReportFiles(reportsDir: string, count: number): string[] {
  if (!fs.existsSync(reportsDir)) return [];
  const files = fs
    .readdirSync(reportsDir)
    .filter((name) => /^REPORT-\d+\.md$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  return files.slice(-count).map((name) => path.join(reportsDir, name));
}

export function parseNextSteps(reportContent: string): string[] {
  const section = extractAnySection(reportContent, ['NEXT STEPS', 'СЛЕДУЮЩИЕ ШАГИ']);
  return parseChecklistItems(section);
}

export function findLatestReportForTask(
  reportsDir: string,
  taskId: string,
): { reportId: string; reportPath: string; reportContent: string } | null {
  const files = getLatestReportFiles(reportsDir, Number.MAX_SAFE_INTEGER).reverse();

  for (const reportPath of files) {
    const content = fs.readFileSync(reportPath, 'utf-8');
    const section = extractSection(content, 'TASK');
    const linkedTask = section.split('\n')[0]?.trim();
    if (linkedTask === taskId) {
      const reportId = path.basename(reportPath, '.md');
      return { reportId, reportPath, reportContent: content };
    }
  }

  return null;
}

export function parseChangedFiles(reportContent: string): string[] {
  const section = extractAnySection(reportContent, ['FILES CHANGED', 'ИЗМЕНЁННЫЕ ФАЙЛЫ']);
  if (!section) return [];

  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const files: string[] = [];
  for (const line of lines) {
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (!bullet) continue;
    const candidate = bullet[1].replace(/^`|`$/g, '').replace(/\s+\(.*\)$/, '').trim();
    if (!candidate || /^not specified$/i.test(candidate)) continue;
    files.push(candidate);
  }

  return Array.from(new Set(files));
}

export function validateReportStructure(reportContent: string): string[] {
  const requiredSections = ['WORK DONE', 'FILES CHANGED', 'TESTS', 'RESULT', 'NEXT STEPS'];
  const missing: string[] = [];

  for (const section of requiredSections) {
    if (!extractSection(reportContent, section)) {
      missing.push(section);
    }
  }

  return missing;
}

export function createReportForTask(
  root: string,
  config: Config,
  taskId: string,
  payload: {
    doneItems: string[];
    changedFiles: string[];
    testsOutput: string;
    nextSteps: string[];
    executor: string;
    status: TaskStatus;
    resultSummary?: string;
  },
): { reportId: string; reportPath: string } {
  const coordination = coordinationRoot(root, config);
  const tasksDir = path.join(coordination, 'tasks');
  const reportsDir = path.join(coordination, 'reports');

  const { taskPath, taskContent } = requireTaskContent(tasksDir, taskId);
  const reportId = nextEntityId(reportsDir, config.report_prefix);
  const reportPath = path.join(reportsDir, `${reportId}.md`);
  const title = extractTaskTitle(taskContent);

  const doneItems = payload.doneItems.length > 0
    ? payload.doneItems.map((item) => `- ✅ ${item}`).join('\n')
    : '- ✅ Implemented task';

  const changedFiles = payload.changedFiles.length > 0
    ? payload.changedFiles.map((item) => `- ${item}`).join('\n')
    : '- Not specified';

  const nextSteps = payload.nextSteps.length > 0
    ? payload.nextSteps.map((item) => `- [ ] ${item}`).join('\n')
    : '- [ ] Define next task';

  const report = `# ${reportId}: ${title}

## DATE
${nowIso()}

## EXECUTOR
${payload.executor}

## STATUS
${payload.status}

## TASK
${taskId}

## WORK DONE
${doneItems}

## FILES CHANGED
${changedFiles}

## TESTS
\`\`\`text
${payload.testsOutput}
\`\`\`

## RESULT
${payload.resultSummary || `Task ${taskId} completed and documented.`}

## NEXT STEPS
${nextSteps}
`;

  writeText(reportPath, report);
  updateTaskStatus(taskPath, payload.status);

  return { reportId, reportPath };
}

export function parseAiResponse(raw: string): ParsedAiReport {
  const statusText = extractAnySection(raw, ['STATUS', 'СТАТУС']).split('\n')[0]?.trim();
  const status = normalizeTaskStatus(statusText);

  const workSection = extractAnySection(raw, ['WORK DONE', 'ВЫПОЛНЕННЫЕ РАБОТЫ']);
  const filesSection = extractAnySection(raw, ['FILES CHANGED', 'ИЗМЕНЁННЫЕ ФАЙЛЫ']);
  const testsSection = extractAnySection(raw, ['TESTS', 'ТЕСТЫ']);
  const resultSection = extractAnySection(raw, ['RESULT', 'РЕЗУЛЬТАТ']);
  const nextStepsSection = extractAnySection(raw, ['NEXT STEPS', 'СЛЕДУЮЩИЕ ШАГИ']);

  const doneItems = parseChecklistItems(workSection);
  const changedFiles = parseChecklistItems(filesSection)
    .map((item) => item.replace(/^`|`$/g, '').trim())
    .filter((item) => /[\/]|\.[a-zA-Z0-9]+$/.test(item));
  const nextSteps = parseChecklistItems(nextStepsSection);

  const testsOutput = testsSection || 'No test output provided by AI response';
  const resultSummary = resultSection || 'Auto-generated report from AI response.';

  return {
    status,
    doneItems: doneItems.length > 0 ? doneItems : ['Implemented task according to AI response'],
    changedFiles: Array.from(new Set(changedFiles)),
    testsOutput,
    nextSteps,
    resultSummary,
  };
}
