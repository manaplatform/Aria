# Aria

Aria is a minimal desktop-first monorepo with a NestJS API and an Electron + React desktop shell. The starter intentionally contains no AI features.

## Requirements

- Node.js 22.12 or newer (required by the Electron desktop app)
- pnpm 9 or newer

## Setup

```sh
pnpm install
cp .env.example .env
```

## Run apps independently

```sh
# NestJS API at http://localhost:3000/health
pnpm dev:api

# Electron desktop app with the Vite development server
pnpm dev:desktop
```

The API reads `PORT` from the environment and defaults to `3000`. The desktop app is a standalone shell and does not require the API to be running.

## Workspace commands

```sh
pnpm build
pnpm typecheck
```

The workspace includes `apps/api`, `apps/desktop`, and `packages/shared` for types that can be shared as the project grows.
