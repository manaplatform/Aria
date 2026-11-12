# Aria desktop frontend

The frontend is implemented in the existing Electron + React 18 + Vite monorepo. Native window frames, context isolation, disabled renderer Node integration, and the NestJS health API are preserved. The desktop does not require the API to start.

## Available behavior

| Area       | Local projects                                                  | Opt-in sample workspace                                                                        |
| ---------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Projects   | Native folder picker, recent projects, read-only Git branch     | Clearly labelled Acme Platform fixture                                                         |
| Chat       | Autosaved drafts and file references; Send unavailable          | Deterministic, labelled streaming response                                                     |
| Planning   | Manually managed tasks, dependencies, statuses, plan checklists | Isolated editable sample tasks and checklists                                                  |
| Execution  | Unavailable without a backend                                   | Inspectable fixture commands, stdout/stderr, file comparisons, tool results, playback and stop |
| Agents     | Explicit unavailable state                                      | Inspectable hierarchy and attributed activity                                                  |
| Approvals  | Unavailable without a backend                                   | Simulated acknowledged approve/deny; no external operation                                     |
| Context    | Read-only directory/file previews and attachments               | Sample file content                                                                            |
| Connection | Real `/health` request from Electron main                       | Same connection diagnostics; sample content is independent                                     |

A successful health check never enables chat or execution. No provider-backed AI, shell execution service, GitHub integration, vector index, or persistent AI memory is included. There is no silent demo fallback.

## Component and state boundaries

- `components/ui`: locally owned shadcn-style Radix primitives, Tailwind utilities, variant-based buttons, overlays, menus, tooltips, tabs, states, copy controls, and accessible resize handles.
- `components/layout`: navigation, project selection, toolbar/search, responsive shell and orchestration panels.
- `components/chat`: composer, conversation rendering, safe Markdown and code blocks.
- `components/execution`: event cards, lazy-loaded terminal and file comparison viewers, virtualized long activity/output lists.
- `components/orchestration`: manual tasks/plans, agent hierarchy, repository context, acknowledged approvals.
- `pages`: Home, Knowledge, Settings, and page compositions for Agents, Tasks, Terminal and History. Workspace uses the chat composition.
- `stores`: persisted local workspace state, normalized live entities, connection diagnostics, and transient notifications. Selectors keep output chunks from rerendering the desktop shell.
- `services`: narrow local desktop access, the backend capability adapter, sample adapter, and exact output-line assembly.
- `styles/tokens.css`: semantic light/dark tokens, sizing, typography, motion, elevation and layering. Responsive CSS switches at 1440px and 1100px.

Shared domain and bridge contracts live in `packages/shared`. Hash routing works under both Vite and the production `file://` loader. UI preferences restore navigation, theme, project, mode, widths, section heights and collapse state. At narrow widths the orchestration drawer starts closed to prioritize the main view.

## IPC, files and persistence

`window.aria` retains `platform` and exposes only named operations: load/save local data, choose a project, inspect its repository, list/read scoped files, choose attachments, check health, copy, open HTTP(S) links, and flush before closing. Main validates the sender, arguments and persisted data. Renderer Node integration remains disabled and the preload runs sandboxed.

Main process file access resolves real paths inside a previously selected project. Absolute paths, escaping traversal/symlinks, unregistered roots, unsafe external protocols, and credential-bearing external URLs are rejected. Directory browsing omits `.git`, `node_modules`, `.DS_Store` and symlinks. Git runs only fixed read-only argument arrays, with no shell. This implementation never edits project files or runs user-entered commands.

Local work is written atomically to `workspace-v1.json` in Electron's application-data directory. Draft saves are debounced and serialized; a close handshake waits for the last save. A save failure is visible and keeps the window open. Unreadable documents are preserved in a timestamped recovery copy. Sample events, messages, tasks, plans, and approvals are kept in memory and never serialized into local work. UI preferences remain global.

Text previews are bounded to 1 MiB, identify truncation, and suppress binary content. Browsing is per-directory, with a 5,000-entry limit. Local storage is bounded to 8 MB, 500 drafts, 2,000 tasks and 100 plans. These limits produce explicit errors. Clipboard payloads are limited to 10 million characters. File previews and context references are not uploaded.

Production CSP disallows inline scripts. Development uses a fresh nonce for Vite's React refresh preamble; the production policy remains strict. External navigation and window creation are blocked in the application renderer. Supported links go through the validated main-process bridge.

## Connecting future services

Implement `WorkspaceAdapter` against the backend's actual protocol; do not infer support from `/health`. Enable only capabilities the service really provides. The existing backend adapter returns an empty snapshot and explicit unsupported-operation errors.

Snapshots and updates carry stable workspace/entity IDs, revisions, event sequences, chunk IDs, and a resume cursor. The projection deduplicates output, rejects stale revisions and late workspace responses, and buffers frequent updates at 50ms. Subscriptions return cleanup functions; switching projects disposes the previous adapter subscription. A future transport must validate its wire payloads and implement its own reconnect/resume behavior before advertising streaming. The current backend has no live transport to reconnect.

Approval state changes only after adapter acknowledgement. Pending state is shared between duplicate views. Error feedback retains the pending request. Command display text and executable/argument arrays are separate fields: the UI displays the supplied text and never reconstructs an executable shell command from it.

## Verification and limitations

Run from the repository root:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:electron
```

Electron tests use isolated temporary projects and application-data directories. They cover built file-loaded startup, Vite development startup, all navigation destinations, local task/plan flows, file copying, close-time draft persistence, appearance restoration, sample streaming and approvals, keyboard search, panel resize/collapse, and screenshots at 1600, 1440, 1280, 1024 and 720 pixels. Screenshots are generated under `apps/desktop/.artifacts/screenshots/` and ignored by Git.

Unit/component tests cover event projection, stale project responses, dependency validation, sample cleanup and acknowledgements, path/link boundaries, malformed data recovery, preview limits, health checks, Markdown safety, composer keyboard/IME handling, reading-position preservation, and long/chunked output.

Acceptance was exercised on macOS. Windows/Linux retain native framing and platform-neutral IPC, but runtime acceptance on those operating systems remains unverified. Installer packaging, application icons, auto-update, backend authentication and real agent execution remain separate work.

## Changed files

Paths below are relative to the repository root.

| Change                            | Files                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expanded contracts                | `packages/shared/src/index.ts`                                                                                                                                                                                                                                                              |
| Updated desktop entry and styling | `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`, `apps/desktop/index.html`                                                                                                                                                                                                        |
| New shared UI and tokens          | `apps/desktop/src/components/ui/index.tsx`, `apps/desktop/src/lib/utils.ts`, `apps/desktop/src/styles/tokens.css`, `apps/desktop/src/types.d.ts`                                                                                                                                            |
| New shell                         | `apps/desktop/src/components/layout/{DesktopShell,OrchestrationSidebar}.tsx`                                                                                                                                                                                                                |
| New chat                          | `apps/desktop/src/components/chat/{ChatWorkspace,MarkdownRenderer}.tsx`                                                                                                                                                                                                                     |
| New execution views               | `apps/desktop/src/components/execution/{ExecutionTimeline,TerminalOutput,DiffViewer}.tsx`                                                                                                                                                                                                   |
| New orchestration views           | `apps/desktop/src/components/orchestration/{Tasks,Agents,Approvals,Context}.tsx`                                                                                                                                                                                                            |
| New pages and hooks               | `apps/desktop/src/pages/{Home,Knowledge,Settings,WorkPages}.tsx`, `apps/desktop/src/hooks/useWorkspace.ts`                                                                                                                                                                                  |
| New stores                        | `apps/desktop/src/stores/{workspaceStore,executionStore,connectionStore,uiStore}.ts`                                                                                                                                                                                                        |
| New adapters and helpers          | `apps/desktop/src/services/{desktop,adapters,sample,output}.ts`                                                                                                                                                                                                                             |
| Updated Electron bridge           | `apps/desktop/electron/{main,preload}.ts`                                                                                                                                                                                                                                                   |
| New main-process services         | `apps/desktop/electron/{project,storage}.ts`                                                                                                                                                                                                                                                |
| New verification                  | `apps/desktop/tests/{adapters,events,output,security}.test.ts`, `apps/desktop/tests/ui.test.tsx`, `apps/desktop/tests/{setup.ts,workspace.electron.ts}`                                                                                                                                     |
| Build and tooling                 | New `apps/desktop/{vite.config.mts,vitest.config.mts,playwright.config.ts,eslint.config.mjs,tsconfig.tests.json,components.json}` and root `.prettierrc.json`; updated desktop `tsconfig.json`, package manifests, lockfile, and `.gitignore`. `vite.config.mts` replaces `vite.config.ts`. |
| Documentation                     | Updated `README.md`; added this architecture and delivery inventory.                                                                                                                                                                                                                        |
