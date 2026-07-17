# Contributing to Brothers Protocol CLI

Thanks for your interest! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/aiorkestrator-ru/brothers-protocol-cli-mvp
cd brothers-protocol-cli-mvp
npm install
npm run build
```

Run tests:

```bash
npm test        # 7 unit tests
npm run smoke   # end-to-end smoke run
```

Dev mode (no build step):

```bash
npm run dev -- init
npm run dev -- task "My task"
```

## Project Structure

```
src/
└── cli.ts          # single-file CLI (~1600 lines, TypeScript)
tests/
└── *.test.mjs      # Node.js built-in test runner
scripts/
└── smoke.sh        # reproducible end-to-end test
```

The entire CLI lives in `src/cli.ts`. This is intentional — zero runtime dependencies beyond `commander`. Everything is self-contained and auditable.

## How to Contribute

### Bug reports

Open an issue with:
- Brothers Protocol version (`brothers --version`)
- Node.js version (`node --version`)
- Minimal reproduction steps
- Expected vs actual behavior

### Feature requests

Open an issue describing:
- The use case (what are you trying to do?)
- Why existing commands don't cover it
- Proposed CLI interface (command + flags)

### Pull Requests

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-feature`
3. Make changes in `src/cli.ts`
4. Add/update tests in `tests/`
5. Run `npm test` — all 7 tests must pass
6. Run `npm run smoke` — full flow must pass
7. Open a PR with a clear description

### Code Style

- TypeScript, strict mode
- No external runtime dependencies (only `commander` is allowed)
- Every new command needs at least one test in `tests/`
- Functions under 50 lines preferred; extract helpers if longer
- Error messages must be actionable: tell the user what to do next

## Roadmap Ideas

- `brothers checkpoint` — snapshot current state to resume after crash
- `brothers audit` — scan all tasks for missing artifacts or stale batons
- Multi-project workspace support
- Web UI dashboard (read-only, shows task graph)
- Native AI provider: Google Gemini

## License

By contributing, you agree your code will be released under the [MIT License](LICENSE).
