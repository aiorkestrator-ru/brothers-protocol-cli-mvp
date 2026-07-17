import fs from 'node:fs';
import path from 'node:path';
import { readTextIfExists, toAbs } from './fsutil.js';
import { type Config, coordinationRoot } from './config.js';
import { getLatestReportFiles } from './reports.js';

export function sanitizePrompt(raw: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/ghp_[A-Za-z0-9]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
    [/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]'],
    [/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]'],
    [/AIza[0-9A-Za-z-_]{20,}/g, '[REDACTED_GOOGLE_KEY]'],
    [/(password\s*[:=]\s*)[^\s\n]+/gi, '$1[REDACTED_PASSWORD]'],
    [/(token\s*[:=]\s*)[^\s\n]+/gi, '$1[REDACTED_TOKEN]'],
    [/(api[_-]?key\s*[:=]\s*)[^\s\n]+/gi, '$1[REDACTED_API_KEY]'],
    [/(authorization\s*:\s*bearer\s+)[^\s\n]+/gi, '$1[REDACTED_BEARER]'],
  ];

  let sanitized = raw;
  for (const [pattern, replacement] of replacements) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

export function buildPrompt(
  root: string,
  config: Config,
  taskId: string,
  taskContent: string,
): { rawPrompt: string; sanitizedPrompt: string } {
  const coordination = coordinationRoot(root, config);
  const rules = readTextIfExists(toAbs(root, config.rules_file));
  const conventions = readTextIfExists(toAbs(root, config.conventions_file));
  const latestReports = getLatestReportFiles(path.join(coordination, 'reports'), 3)
    .map((reportPath) => `\n---\nFile: ${path.basename(reportPath)}\n${fs.readFileSync(reportPath, 'utf-8')}`)
    .join('\n');

  const stackLine = config.stack?.length
    ? `STACK: ${config.stack.join(', ')}`
    : '';
  const docsBlock = config.stack_docs?.length
    ? `DOCUMENTATION (fetch these llms.txt for current API reference):\n${config.stack_docs.map(u => `- ${u}`).join('\n')}`
    : '';

  const rawPrompt = [
    'CONTEXT: Working with Brothers Protocol',
    '',
    stackLine,
    docsBlock,
    '',
    `RULES:\n${rules || '[No AI_RULES.md found]'}`,
    '',
    `CONVENTIONS:\n${conventions || '[No CONVENTIONS.md found]'}`,
    '',
    `TASK: ${taskId}\n${taskContent}`,
    '',
    `RECENT REPORTS:\n${latestReports || '[No reports yet]'}`,
    '',
    'INSTRUCTION:\nComplete the task and return a report using project template.',
  ].filter(Boolean).join('\n');

  return { rawPrompt, sanitizedPrompt: sanitizePrompt(rawPrompt) };
}
