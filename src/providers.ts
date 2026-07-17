export function defaultMockAiResponse(): string {
  return `## WORK DONE
- ✅ Implemented requested changes
- ✅ Updated related docs

## FILES CHANGED
- coordination/tasks/TASK-001.md

## TESTS
PASS mock-tests

## RESULT
Task completed in mock mode.

## NEXT STEPS
- [ ] Validate on staging
`;
}

export async function callOpenAI(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'Return a markdown report with sections: WORK DONE, FILES CHANGED, TESTS, RESULT, NEXT STEPS.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI response does not contain message content');

  return content;
}

export async function callAnthropic(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
      system: 'Return a markdown report with sections: WORK DONE, FILES CHANGED, TESTS, RESULT, NEXT STEPS.',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic request failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  const content = (data.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');

  if (!content) throw new Error('Anthropic response does not contain text content');
  return content;
}

export async function callClaudeCode(prompt: string): Promise<string> {
  // Claude Code blocks nested sessions (CLAUDECODE env var is set when running inside Claude Code)
  if (process.env.CLAUDECODE) {
    throw new Error(
      'Cannot call Claude Code from within a Claude Code session.\n' +
      'Run brothers commands from a regular terminal (outside Claude Code).',
    );
  }

  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('claude', ['--print'], {
    input: prompt,
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(
        'claude command not found. Make sure Claude Code is installed and in PATH.\n' +
        'Install: https://claude.ai/code',
      );
    }
    throw new Error(`Claude Code error: ${err.message}`);
  }

  if (result.status !== 0) {
    const errMsg = (result.stderr as string) || `exit code ${result.status}`;
    throw new Error(`Claude Code failed: ${errMsg.trim()}`);
  }

  const output = (result.stdout as string) || '';
  // Strip ANSI escape codes for clean report parsing
  return output.replace(/\x1b\[[0-9;]*m/g, '').trim();
}

export async function callAiProvider(provider: string, prompt: string, model: string | undefined, attempt: number): Promise<string> {
  const normalized = provider.toLowerCase();

  if (normalized === 'mock') {
    const failCount = Number(process.env.BROTHERS_MOCK_FAILS || '0');
    if (attempt <= failCount) {
      throw new Error(`Mock provider forced failure on attempt ${attempt}/${failCount}`);
    }
    return process.env.BROTHERS_MOCK_AI_RESPONSE || defaultMockAiResponse();
  }

  if (normalized === 'openai') return callOpenAI(prompt, model || 'gpt-4.1-mini');
  if (normalized === 'anthropic' || normalized === 'claude') return callAnthropic(prompt, model || 'claude-3-5-sonnet-latest');
  if (normalized === 'claude-code') return callClaudeCode(prompt);

  throw new Error(`Unsupported AI provider for --auto: ${provider}. Use one of: mock, openai, anthropic, claude-code`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callAiWithRetry(
  provider: string,
  prompt: string,
  model: string | undefined,
  retries: number,
  retryDelayMs: number,
): Promise<string> {
  let lastError: unknown;
  const maxAttempts = Math.max(1, retries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callAiProvider(provider, prompt, model, attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;

      console.log(`AI attempt ${attempt} failed: ${(error as Error).message}`);
      const delay = retryDelayMs * attempt;
      console.log(`Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw new Error(`AI provider failed after ${maxAttempts} attempts: ${(lastError as Error).message}`);
}
