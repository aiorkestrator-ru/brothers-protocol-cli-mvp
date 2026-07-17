import fs from 'node:fs';
import path from 'node:path';

// ─── Stack detection ──────────────────────────────────────────────────────────
export type StackInfo = { stack: string[]; docs: string[]; mcp: string[] };

/** Read prisma/schema.prisma → return provider string (postgresql|sqlite|mysql|...) */
function detectPrismaProvider(root: string): string | null {
  for (const p of ['prisma/schema.prisma', 'schema.prisma']) {
    const full = path.join(root, p);
    if (!fs.existsSync(full)) continue;
    const m = fs.readFileSync(full, 'utf-8').match(/provider\s*=\s*"([^"]+)"/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Read drizzle.config.* → return dialect string (postgresql|sqlite|mysql) */
function detectDrizzleDialect(root: string): string | null {
  for (const c of ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs']) {
    const full = path.join(root, c);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf-8');
    if (/dialect\s*:\s*['"]postgresql['"]|dialect\s*:\s*['"]pg['"]/.test(src)) return 'postgresql';
    if (/dialect\s*:\s*['"]sqlite['"]/.test(src)) return 'sqlite';
    if (/dialect\s*:\s*['"]mysql['"]/.test(src))  return 'mysql';
  }
  return null;
}

function addPostgres(stack: string[], mcp: string[]): void {
  if (!stack.includes('postgresql')) stack.push('postgresql');
  if (!mcp.includes('@modelcontextprotocol/server-postgres')) mcp.push('@modelcontextprotocol/server-postgres');
}

function addSqlite(stack: string[], mcp: string[]): void {
  if (!stack.includes('sqlite')) stack.push('sqlite');
  if (!mcp.includes('mcp-server-sqlite')) mcp.push('mcp-server-sqlite');
}

export function detectStack(root: string): StackInfo {
  const stack: string[] = [];
  const docs:  string[] = [];
  // Vibe-coder baseline: filesystem is always useful for AI agents working in a codebase
  const mcp: string[] = ['@modelcontextprotocol/server-filesystem'];

  // Git repo → GitHub MCP (issue/PR management)
  if (fs.existsSync(path.join(root, '.git')) || fs.existsSync(path.join(root, '.github'))) {
    mcp.push('@modelcontextprotocol/server-github');
  }

  // GitLab (takes priority over GitHub when both present is unusual, but check anyway)
  if (fs.existsSync(path.join(root, '.gitlab-ci.yml'))) {
    mcp.push('@modelcontextprotocol/server-gitlab');
  }

  // Node.js / package.json
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    stack.push('nodejs');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Frameworks
      if (deps['next'])   { stack.push('nextjs');  docs.push('https://nextjs.org/llms.txt'); }
      if (deps['astro'])  { stack.push('astro');   docs.push('https://docs.astro.build/llms.txt'); }
      if (deps['vue'])    { stack.push('vue');      docs.push('https://vuejs.org/llms.txt'); }
      if (deps['react'] && !deps['next'] && !deps['astro']) stack.push('react');
      if (deps['express'])  stack.push('express');
      if (deps['fastify'])  stack.push('fastify');
      if (deps['typescript'] || deps['@types/node']) stack.push('typescript');
      if (deps['ink']) stack.push('ink-tui');

      // PostgreSQL — only explicit pg drivers
      if (deps['pg'] || deps['postgres']) addPostgres(stack, mcp);

      // Prisma — check schema for real provider
      if (deps['@prisma/client']) {
        stack.push('prisma');
        const provider = detectPrismaProvider(root);
        if (provider === 'postgresql') addPostgres(stack, mcp);
        else if (provider === 'sqlite') addSqlite(stack, mcp);
        else if (provider === 'mysql')  stack.push('mysql');
      }

      // Drizzle — check config for real dialect
      if (deps['drizzle-orm']) {
        stack.push('drizzle');
        const dialect = detectDrizzleDialect(root);
        if (dialect === 'postgresql') addPostgres(stack, mcp);
        else if (dialect === 'sqlite') addSqlite(stack, mcp);
        else if (dialect === 'mysql')  stack.push('mysql');
      }

      // SQLite — explicit drivers
      if (deps['better-sqlite3'] || deps['sqlite3']) addSqlite(stack, mcp);

      // Browser automation — prefer @playwright/mcp (official, modern)
      if (deps['@playwright/test'] || deps['playwright']) mcp.push('@playwright/mcp');
      else if (deps['puppeteer'])                          mcp.push('@modelcontextprotocol/server-puppeteer');

      // AI stack detection (Node.js)
      // No official MCP servers exist for AI providers yet — suggest memory+search instead
      const aiDeps = ['openai', 'anthropic', '@anthropic-ai/sdk', '@google/generative-ai',
                      'langchain', '@langchain/core', 'llamaindex', 'ai', 'ollama'];
      const hasAiDep = aiDeps.some(d => !!deps[d]);
      if (hasAiDep) {
        if (deps['openai'])                          stack.push('openai');
        if (deps['anthropic'] || deps['@anthropic-ai/sdk']) stack.push('anthropic');
        if (deps['@google/generative-ai'])           stack.push('gemini');
        if (deps['langchain'] || deps['@langchain/core']) stack.push('langchain');
        if (deps['llamaindex'])                      stack.push('llamaindex');
        if (deps['ai'])                              stack.push('vercel-ai-sdk');
        if (deps['ollama'])                          stack.push('ollama');
        // Useful MCPs when building AI solutions
        if (!mcp.includes('@modelcontextprotocol/server-memory'))
          mcp.push('@modelcontextprotocol/server-memory');
        if (!mcp.includes('@modelcontextprotocol/server-brave-search'))
          mcp.push('@modelcontextprotocol/server-brave-search');
      }

    } catch { /* malformed package.json */ }
  }

  // Python
  const pyFiles = ['pyproject.toml', 'requirements.txt', 'requirements.in'];
  if (pyFiles.some(f => fs.existsSync(path.join(root, f)))) {
    stack.push('python');
    const content = pyFiles
      .map(f => path.join(root, f))
      .filter(p => fs.existsSync(p))
      .map(p => fs.readFileSync(p, 'utf-8'))
      .join('\n')
      .toLowerCase();
    if (content.includes('fastapi')) { stack.push('fastapi'); docs.push('https://fastapi.tiangolo.com/llms.txt'); }
    if (content.includes('django'))  stack.push('django');
    if (content.includes('flask'))   stack.push('flask');
    // PostgreSQL — only explicit pg drivers, not sqlalchemy alone
    if (content.includes('psycopg2') || content.includes('psycopg') || content.includes('asyncpg')) addPostgres(stack, mcp);
    // SQLite
    if (content.includes('aiosqlite') || content.includes('databases[sqlite')) addSqlite(stack, mcp);
    // Playwright for Python
    if (content.includes('playwright')) mcp.push('@playwright/mcp');
    // AI stack detection (Python)
    const pyAiLibs: Record<string, string> = {
      'openai':            'openai',
      'anthropic':         'anthropic',
      'google-generativeai': 'gemini',
      'langchain':         'langchain',
      'llama-index':       'llamaindex',
      'llama_index':       'llamaindex',
      'ollama':            'ollama',
    };
    let foundAi = false;
    for (const [lib, label] of Object.entries(pyAiLibs)) {
      if (content.includes(lib) && !stack.includes(label)) { stack.push(label); foundAi = true; }
    }
    if (foundAi) {
      if (!mcp.includes('@modelcontextprotocol/server-memory'))
        mcp.push('@modelcontextprotocol/server-memory');
      if (!mcp.includes('@modelcontextprotocol/server-brave-search'))
        mcp.push('@modelcontextprotocol/server-brave-search');
    }
  }

  // Rust / Go
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) stack.push('rust');
  if (fs.existsSync(path.join(root, 'go.mod')))     stack.push('go');

  return {
    stack: [...new Set(stack)],
    docs:  [...new Set(docs)],
    mcp:   [...new Set(mcp)],
  };
}
