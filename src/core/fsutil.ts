import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readTextIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
}

export function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function toAbs(root: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(root, maybeRelative);
}

export function nowIso(): string {
  const now = new Date();
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

export function splitList(raw: string | undefined, separators: RegExp = /[;,]/): string[] {
  if (!raw) return [];
  return raw
    .split(separators)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function boolFromMode(mode: string | undefined, fallback: boolean): boolean {
  if (!mode || mode === 'auto') return fallback;
  if (mode === 'on' || mode === 'true' || mode === '1') return true;
  if (mode === 'off' || mode === 'false' || mode === '0') return false;
  throw new Error(`Invalid mode: ${mode}. Expected on|off|auto`);
}

export function numericIdsFromFiles(dirPath: string, prefix: string, extension = '.md'): number[] {
  if (!fs.existsSync(dirPath)) return [];
  const escapedExt = extension.replace('.', '\\.');
  const matcher = new RegExp(`^${prefix}-(\\d+)${escapedExt}$`);
  return fs
    .readdirSync(dirPath)
    .map((name) => {
      const match = name.match(matcher);
      return match ? Number(match[1]) : null;
    })
    .filter((id): id is number => Number.isFinite(id));
}

export function nextEntityId(dirPath: string, prefix: string, extension = '.md'): string {
  ensureDir(dirPath);
  // Atomic ID allocation: O_EXCL fails if file already exists, preventing race conditions
  // when multiple CLI processes run concurrently (e.g. in CI pipelines).
  for (let attempt = 0; attempt < 20; attempt++) {
    const ids = numericIdsFromFiles(dirPath, prefix, extension);
    const next = ids.length === 0 ? 1 : Math.max(...ids) + 1;
    const candidate = `${prefix}-${String(next).padStart(3, '0')}`;
    const placeholder = path.join(dirPath, `${candidate}${extension}`);
    try {
      // O_CREAT | O_EXCL: creates file only if it does NOT exist (atomic on POSIX)
      const fd = fs.openSync(placeholder, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.closeSync(fd);
      // Placeholder written — caller's writeText() will overwrite with real content
      return candidate;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; // another process claimed this ID
      throw e;
    }
  }
  throw new Error(`Failed to allocate unique ${prefix} ID after 20 attempts (concurrent writes?)`);
}
