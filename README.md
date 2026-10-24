# AgentWorkflowGui

Local desktop GUI (Electron + React + TypeScript, Windows first) for managing reusable agent workflows across Claude and Codex sessions.

This repository currently contains only the project skeleton: an empty window plus the module layout.

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
```

Dependency direction (enforced by `npm run lint`, see `eslint.config.mjs`):

- `app/renderer` may import only `contracts` (and the preload bridge types) — never `core`, `adapters`, Electron or Node modules.
- `core` may not import Electron, React, Node modules, `adapters` or `app`.
- `contracts` depends on nothing else; `adapters` may not import `app` or UI libraries.

## Electron security

The window is created with `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`. The preload script exposes a single example API, `window.awg.getAppInfo()`, through `contextBridge`; there is no generic `invoke`.
