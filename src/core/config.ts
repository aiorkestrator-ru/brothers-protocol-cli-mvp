import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { toAbs, writeText } from './fsutil.js';

export type Config = {
  project: string;
  version: string;
  ai_provider: string;
  ai_model: string;
  auto_sanitize_prompt: boolean;
  ai_retries: number;
  ai_retry_delay_ms: number;
  coordination_dir: string;
  auto_commit: boolean;
  task_prefix: string;
  report_prefix: string;
  conventions_file: string;
  rules_file: string;
  baton_ttl_hours: number;
  test_command?: string;    // command executed by relay-check --run-tests, e.g. "npm test"
  stack?: string[];         // detected tech stack, e.g. ["nextjs", "typescript", "postgresql"]
  stack_docs?: string[];    // llms.txt doc URLs for the stack
  mcp_suggested?: string[]; // recommended MCP server packages
};

export const DEFAULT_CONFIG: Config = {
  project: path.basename(process.cwd()),
  version: '1.0.0',
  ai_provider: 'manual',
  ai_model: '',
  auto_sanitize_prompt: true,
  ai_retries: 2,
  ai_retry_delay_ms: 800,
  coordination_dir: './coordination',
  auto_commit: false,
  task_prefix: 'TASK',
  report_prefix: 'REPORT',
  conventions_file: './CONVENTIONS.md',
  rules_file: './AI_RULES.md',
  baton_ttl_hours: 72,
};

export function findProjectRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.brothers-config.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Project is not initialized. Run: brothers init');
    }
    current = parent;
  }
}

export function loadConfig(root: string): Config {
  const configPath = path.join(root, '.brothers-config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('Missing .brothers-config.json. Run: brothers init');
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export function saveConfig(root: string, config: Config): void {
  writeText(path.join(root, '.brothers-config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

export function coordinationRoot(root: string, config: Config): string {
  return toAbs(root, config.coordination_dir);
}

const SECRET_FILE = '.brothers-secret';

/**
 * Загружает (или создаёт при первом обращении) секрет для HMAC-подписи батонов.
 * Секрет живёт в <root>/.brothers-secret с правами 0600 и автоматически
 * добавляется в .gitignore — он не должен попадать в репозиторий.
 */
export function loadOrCreateSecret(root: string): string {
  const secretPath = path.join(root, SECRET_FILE);
  if (fs.existsSync(secretPath)) {
    const secret = fs.readFileSync(secretPath, 'utf-8').trim();
    if (secret.length >= 32) return secret;
    throw new Error(`${SECRET_FILE} is present but too short (need >= 32 chars). Delete it to regenerate.`);
  }

  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, `${secret}\n`, { encoding: 'utf-8', mode: 0o600 });
  ensureSecretIgnored(root);
  return secret;
}

/** Добавляет .brothers-secret в .gitignore проекта, если его там ещё нет. */
export function ensureSecretIgnored(root: string): void {
  const gitignorePath = path.join(root, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  if (existing.split('\n').some((line) => line.trim() === SECRET_FILE)) return;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gitignorePath, `${prefix}${SECRET_FILE}\n`, 'utf-8');
}

/**
 * Определяет команду тестов проекта для relay-check --run-tests.
 * Возвращает undefined, если уверенного кандидата нет.
 */
export function detectTestCommand(root: string): string | undefined {
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
      const testScript = pkg.scripts?.test;
      if (testScript && !/no test specified/i.test(testScript)) return 'npm test';
    } catch { /* malformed package.json */ }
  }
  const pytestMarkers = ['pytest.ini', 'setup.cfg', 'pyproject.toml'];
  const hasPy = pytestMarkers.some((f) => {
    const full = path.join(root, f);
    return fs.existsSync(full) && /pytest/i.test(fs.readFileSync(full, 'utf-8'));
  });
  if (hasPy) return 'pytest';
  return undefined;
}
