# Aria

Aria is a desktop-first AI chatbot built with Electron, React, TypeScript, Tailwind, Radix UI, NestJS, and Vercel AI SDK.

## Start

Requires Node.js 22.12+ and pnpm 9.12.3 for development.

```sh
pnpm install
pnpm dev:desktop
```

Aria opens directly into chat. In **Settings → Model connection**, enter your OpenAI-compatible endpoint, model ID, and API key, then choose **Save & reconnect**. Use **Test connection** to send a short provider probe. A configured key/model is distinguished from a tested connection.

Electron starts and stops the NestJS API automatically. You do not need to create a project or launch a server separately. The built desktop runs its staged API using Electron’s embedded Node runtime.

API keys saved in Settings are encrypted in the main process using the operating system’s credential protection. Encryption failures never fall back to plaintext storage. Keys are not returned by the settings API or included in conversation data.

## Configuration

Settings supports the provider endpoint, model ID, API key, and system instructions. The default endpoint is `https://api.openai.com/v1`; select a model available through your provider.

Official OpenAI endpoints use the native Responses API, including support for reasoning models such as GPT-6 Luna. Other endpoints use the OpenAI-compatible Chat Completions adapter.

Nonempty environment variables override saved settings: `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, and `ARIA_SYSTEM_PROMPT`. Development reads the repository’s `.env`; `.env.example` documents the optional variables. Leave them blank to configure Aria through Settings. Changing backend source requires restarting the desktop development command to restage the API.

No production provider credentials are included. Automated tests use an explicitly local fixture provider; a live-provider smoke test requires your own configured credentials.

## Conversations

- Chat immediately after provider setup, with real streaming, Stop, retry/regenerate, safe Markdown, tables, and message/code copying.
- Search titles and message text, rename, pin, and delete conversations through the sidebar.
- Preserve per-conversation drafts and continue receiving replies when switching chats.
- Use Cmd/Ctrl+Shift+O for New Chat, Cmd/Ctrl+K for search, and Cmd/Ctrl+L to focus the composer.
- Choose dark, light, or system appearance. Conversations, profile name, and sidebar preference stay on this device.

The provider receives the newest user message and up to 20 recent completed turns, bounded to 100,000 characters. Full local history remains intact. Interrupted streams retain their partial text and require explicit retry; restarting the service never replays a message automatically. The composer has no attachment controls because file-content delivery is not yet implemented.

## Legacy workspace

**Settings → Advanced → Open legacy workspace** retains existing projects, file browsing, drafts, manual tasks/plans, and clearly labelled sample workflows. These screens live under `/advanced/*` and provide **Return to chat**. Real coding execution and orchestration remain unavailable, as before.

Existing `workspace-v1.json` data migrates to `aria-v2.json` in Electron’s application-data directory. The original remains untouched. Legacy records stay separate from chat history. Writes remain atomic, debounced, and serialized, with close-time flushing and visible save errors. Storage is bounded to 8 MB, 500 chat conversations, 20,000 messages, and 100,000 characters per message; history is never silently evicted.

## Check and build

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:electron
```

Desktop build and predev stage the compiled API plus isolated production dependencies into `apps/desktop/dist-electron/api`. Provider files and `.env` files are not staged. Launch the built desktop with:

```sh
pnpm --filter @aria/desktop exec electron .
```

Electron tests cover production and development startup, managed service streaming/cancellation/restart, encrypted settings, conversation management/persistence, responsive navigation, and legacy behavior. They use temporary application-data directories and a local provider fixture. Screenshots are written to `apps/desktop/.artifacts/screenshots/`. CI runs checks on macOS and Windows; installer packaging, signing, and auto-update are separate work.

The optional standalone API remains available through `pnpm dev:api`. It binds to loopback, defaults to port 3000, and preserves `GET /health`. Chat endpoints require `ARIA_INTERNAL_TOKEN`; the desktop generates its own private token and ephemeral port automatically.

See [frontend architecture](docs/frontend-architecture.md) for process boundaries, persistence, and transport behavior.
