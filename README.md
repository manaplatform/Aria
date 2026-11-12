# Aria

Aria is a desktop-first workspace built with Electron, React, TypeScript, Tailwind, Radix/shadcn-style UI components, and a NestJS API.

## Requirements

- Node.js 22.12 or newer
- pnpm 9 or newer

## Start

```sh
pnpm install
pnpm dev:desktop
```

Open a local project folder to browse files, save drafts, and manage manual tasks and plans. Appearance, navigation, panel sizes and local work persist on this device. Use **Explore sample** to inspect a labelled, isolated workflow with chat streaming, execution cards, agent hierarchy and approvals.

The AI and execution backend is not implemented. Sending chat messages, running commands and external approvals remain explicitly unavailable for real projects. Sample actions never invoke AI, shell commands or external operations.

The optional API currently exposes only `GET /health`:

```sh
pnpm dev:api
```

It defaults to port 3000 and reads `PORT` from the environment. Configure the API address and run an actual health check in Settings. API reachability is displayed separately from AI capability.

## Check and build

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:electron
```

`pnpm test:electron` builds the desktop, starts a local Vite server, and tests both file-loaded and development Electron startup. Tests use temporary project and application-data directories. Screenshot artifacts are written to `apps/desktop/.artifacts/screenshots/`.

After building, launch the production renderer with:

```sh
pnpm --filter @aria/desktop exec electron .
```

See [frontend architecture](docs/frontend-architecture.md) for the component inventory, typed contracts, supported integrations, security boundaries, persistence, and known limits.
