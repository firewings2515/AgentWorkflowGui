# Contributing to AgentWorkflowGui

Developer notes: setup, commands, module layout, dependency rules and Electron security settings.

## Requirements

- Node.js >= 22.12
- npm >= 10

## Commands

```bash
npm install        # install dependencies (also downloads the Electron binary)
npm run dev        # start the app with hot reload
npm test           # run unit tests (Vitest)
npm run lint       # ESLint, including the dependency-direction rules
npm run typecheck  # TypeScript, main/preload/core/... and renderer projects
npm run build      # production bundles into out/ (no packaging)
```

## Layout

```text
app/main/       Electron main process: lifecycle, window, IPC handlers
app/preload/    contextBridge API exposed to the renderer (window.awg)
app/renderer/   React UI
core/           domain and application logic (no Electron / React)
contracts/      versioned commands, events and DTOs
adapters/       runtime, storage and desktop adapters implementing core ports
tests/          cross-cutting tests (dependency-direction regression test and its fixtures)
```

Dependency direction (enforced by `npm run lint`, rules in `eslint.layers.mjs`; static imports, `export … from`, `import()`, `require()` and `typeof import()` are all checked, in every source extension: ts, tsx, mts, cts, js, jsx, mjs, cjs; relative imports are resolved to their target path, so only the target layer matters, not folder names). Plain JS files are not part of any TypeScript project, so lint rejects them in these layers:

- `app/renderer` may import only `contracts` (and the preload bridge types) — never `core`, `adapters`, Electron or Node modules.
- `core` may not import Electron, React (including subpaths such as `react-dom/server`), Node modules, `adapters` or `app`, and has no Node types (`tsconfig.core.json`), so `process` and friends do not typecheck.
- `contracts` depends on nothing else; `adapters` may not import `app` or UI libraries.

`tests/lint-boundaries.test.ts` lints the violating examples in `tests/lint-fixtures/` (stored as `.txt` so lint, typecheck and build ignore them) and fails if a violation stops being reported.

## Electron security

The window is created with `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`. The preload script exposes a single example API, `window.awg.getAppInfo()`, through `contextBridge`; there is no generic `invoke`. Every IPC handler is registered through `handleTrusted` (`app/main/ipc.ts`), which rejects calls whose sender is not the main frame of our window showing the dev server origin or the packaged `index.html`.
