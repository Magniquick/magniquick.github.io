# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server (SvelteKit).
- `npm run build` — produces a static site via `@sveltejs/adapter-static`.
- `npm run preview` — serve the built output.
- `npm run check` — `svelte-kit sync` + `svelte-check` (TypeScript + Svelte diagnostics).
- `npm run test:smoke` — Playwright tests in `tests/`. The config auto-starts `vite dev` on `127.0.0.1:4173` (`playwright.config.ts`). Run a single test with `npx playwright test tests/smoke.spec.ts -g "<title substring>"`.
- `npm run generate:starwars` — regenerates `src/jokes/generated/starwars-frames.json` from `src/jokes/original/sw1.txt`. This runs automatically via the `predev`, `prebuild`, `precheck`, and `pretest:smoke` hooks, so you rarely invoke it directly — but the generated file is required and must exist before `vite dev`/`build`/`check`/Playwright will work.

There is no lint script and no unit test runner; `svelte-check` + Playwright smoke tests are the full verification surface.

## Architecture

This is a single-page SvelteKit app (Svelte 5 runes, `adapter-static`, `ssr = false`, `prerender = true` in `src/routes/+layout.ts`) that renders an in-browser "runtime lab": an xterm.js terminal wired to a Web Worker that emulates a POSIX-ish shell and hosts Pyodide for Python.

Key boundary: **main thread ↔ worker**. All shell/runtime logic lives in the worker; the page is just the terminal UI.

- `src/routes/+page.svelte` — mounts xterm.js (dynamically imported with `fit`, `search`, `web-links` addons), owns line-editing concerns that the worker can't do synchronously (cursor movement, input redraw, history navigation via arrow keys, reverse-i-search on Ctrl-R, tab completion round-trips, Ctrl-C/Ctrl-L/Ctrl-F). Sends `RuntimeRequest` messages, renders `RuntimeEvent` messages. Theming reads Catppuccin Mocha CSS variables at runtime and passes them to xterm's theme.
- `src/runtimeWorker.ts` — the shell. Tokenizer → AST (`CommandNode` / `PipelineNode` / `LogicalNode` / `SequenceNode`) → executor supporting pipes, `&&`/`||`/`;`, redirections (`>`/`>>`/`<`). Implements a large set of coreutils-style builtins (`ls`, `cat`, `grep`, `head`, `tail`, `sort`, `jq`, `xxd`, `curl`, `env`, `ps`, `less`, etc. — see `HELP_TEXT` around line 104). Holds a `ShellState` (cwd, env, aliases, history, mode: `shell` | `python` | `less`). Lazily boots Pyodide for `python` / `python -c` / `python file.py`. File system is a VFS snapshot (`HomeSnapshot`) scoped to `/home/magni` and persisted to IndexedDB (`DB_NAME = 'magniquick-lab'`, `PERSISTENCE_LIMIT = 5 MB`); paths outside `/home/magni` exist for the session only. Star-Wars-style `jokeCommands` are run before normal resolution.
- `src/runtimeProtocol.ts` — the wire format. Keep `RuntimeRequest` / `RuntimeEvent` / `ShellMode` in sync on both sides when adding features; `+page.svelte` exhaustively switches on `RuntimeEvent.type`.
- `src/jokeCommands.ts` + `src/jokes/` — Asciimation-driven joke commands. `src/jokes/generated/starwars-frames.json` is a build artifact produced by `scripts/generate-starwars-animation.mjs` from `sw1.txt`; treat it as generated (don't hand-edit).
- `src/data/` — static content (`profile.ts`, `projects.ts`) consumed by both the page and the worker (e.g. for `cat /home/magni/README.txt`-style seeded files).

### Things that look weird but are intentional

- `vite.config.ts` sets `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin` on both `server` and `preview`. These are required for Pyodide's `SharedArrayBuffer`-based interrupts. Don't remove them, and preserve them in any deployment config you add.
- `optimizeDeps.exclude: ['pyodide']` and `worker.format: 'es'` are required for Pyodide to load inside the worker.
- `manualChunks` in `vite.config.ts` splits `@xterm` and `pyodide` into their own bundles to keep the main bundle small.
- The worker exposes `window.__labTerminal` and `window.__labRuntimeState` from the main thread for Playwright to inspect the xterm buffer and busy state (see `tests/smoke.spec.ts`). Don't rename without updating the tests.
- Root `index.html` referencing `src/main.tsx` is a stale artifact; SvelteKit uses `src/app.html`. Ignore `index.html`.
- Ctrl-R reverse-i-search, tab completion, and history navigation are implemented in the main thread against a mirrored copy of `history` that the worker ships in every `prompt` event. If you touch line editing, update both sides together.
