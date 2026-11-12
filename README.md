# Aria

Aria is a desktop-first AI chatbot built with Electron, React, TypeScript, Tailwind, Radix UI, NestJS, and Vercel AI SDK.

## Start

Requires Node.js 22.12+ and pnpm 9.12.3 for development.

```sh
pnpm install
pnpm dev:desktop
```

Aria opens directly into chat. In **Settings → AI Models**, add a connection, enter its endpoint and key, and choose **Discover models**. Enable models you want to use, select a primary that supports text streaming and function calling, and save. Electron manages the local NestJS service.

## AI Models and Conductor

The primary model answers ordinary questions directly. It can also call tools, delegate to enabled models, and combine their results into a reply. Every model belongs to the same registry. AI Models controls provider connections, delegation, execution preferences, privacy, and the Live Voice profile.

Aria uses the native Responses API for the official OpenAI endpoint and Chat Completions for compatible endpoints. Models must appear in the connected account’s catalog. Discovery combines provider metadata with exact IDs from documented OpenAI capabilities. Compatible endpoints that list only IDs can use explicit capability declarations in Settings. Run **Verify for primary** to confirm streaming function calling before selecting a model with declared capabilities. A provider can still reject an operation at execution time.

Settings encrypts API keys through Electron’s operating-system credential storage. Existing desktop provider settings migrate from `provider.json` to `provider-v2.json`, including the encrypted key, primary candidate, media candidates, and Live Voice choice. Open AI Models to repair a missing model or verify an unknown capability. If you configured desktop through the environment, choose **Import environment settings** once. Afterward, manage model selection in Settings.

By default, delegation uses the primary connection. Settings lets you allow delegation across connections and separately authorize attachment transfer. Enable **OpenAI Web Search** on an eligible OpenAI connection to use hosted research and source links. A search sends a query to the model chosen for that tool and can incur provider charges. Failed operations identify the affected capability and keep any valid partial results.

## Conversations

- Chat immediately after provider setup, with real streaming, Stop, retry/regenerate, safe Markdown, tables, and message/code copying.
- Search titles and message text, rename, pin, and delete conversations through the sidebar.
- Preserve per-conversation drafts and continue receiving replies when switching chats.
- Use Cmd/Ctrl+Shift+O for New Chat, Cmd/Ctrl+K for search, and Cmd/Ctrl+L to focus the composer.
- Choose dark, light, or system appearance. Conversations, profile name, and sidebar preference stay on this device.

The primary receives the latest message and up to 20 completed prior turns, bounded to 100,000 characters. The expanded activity panel shows delegated models, tools, status, and sources. Aria retains partial replies on interruption. **Retry response** uses the same configuration when the service confirmed that no delegated provider operation started. **Send again** starts a new attempt with current settings. Service restarts never replay a turn.

## Attachments and Live Voice

Use **Attach files** to add up to four supported files. Ask for the operation in the prompt.

- **Images and vision** support PNG, JPEG, or WebP inputs up to 20 MB each. Ask for a description or an edit, or generate an image from text. **Use image** attaches a generated image to the next message.
- **Transcription and speech** support one FLAC, MP3, MP4/M4A, MPEG/MPGA, OGG, WAV, or WebM recording up to 25 MB per transcription step. Speech returns playable WAV audio.
- **Text files** support UTF-8 inputs up to 1 MB. Conductor can read a bounded excerpt and create downloadable plain text, Markdown, CSV, TSV, or JSON.
- **Live Voice** uses the profile in AI Models. Start the microphone from chat. GPT-Live handles the spoken interaction and forwards delegated requests to the same primary through Conductor. Leaving chat, switching conversations, or closing Aria ends the session and cancels delegated work. The app stores timestamped captions and assistant audio locally. Microphone input is transient. [GPT-Live client delegation](https://developers.openai.com/api/docs/guides/live-delegation#configure-client-delegation)

Use **Download** to export an artifact through the system save dialog. Each run can produce up to four artifacts totaling 64 MB. The five-minute run limit covers orchestration and generation. Deleting a conversation prunes files no longer referenced by history or drafts.

## Legacy workspace

**Settings → Advanced → Open legacy workspace** retains existing projects, file browsing, drafts, manual tasks/plans, and clearly labelled sample workflows. These screens live under `/advanced/*` and provide **Return to chat**. The advanced screens retain their local and sample workflows. Conductor runs in the main chat.

Existing `workspace-v1.json` and `aria-v2.json` data migrate to `aria-v3.json` in Electron’s application-data directory. The original remains untouched. Legacy records stay separate from chat history. Writes remain atomic, debounced, and serialized, with close-time flushing and visible save errors. Conversation JSON is bounded to 8 MB, 500 chat conversations, 20,000 messages, and 100,000 characters per message; history is never silently evicted.

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

Electron tests cover production and development startup, managed service streaming/cancellation/restart, encrypted settings, conversation management/persistence, responsive navigation, fetched model selection, image editing, transcription, media export/persistence/cancellation, synthetic-microphone GPT-Live, and legacy behavior. Commercial-provider generation and physical-microphone acceptance must be checked separately. They use temporary application-data directories and a local provider fixture. Screenshots are written to `apps/desktop/.artifacts/screenshots/`. CI runs checks on macOS and Windows; installer packaging, signing, and auto-update are separate work.

The standalone API runs with `pnpm dev:api`, binds to loopback, and defaults to port 3000. Configure its primary with `OPENAI_MODEL`, `OPENAI_API_KEY`, and optional `OPENAI_BASE_URL`. For ID-only compatible catalogs, `ARIA_MODEL_CAPABILITIES=chat,tools` explicitly declares standalone primary support. `GET /health` is unchanged. Private endpoints require `ARIA_INTERNAL_TOKEN`. `POST /chat/stream` uses the configured primary and rejects a request-level `model` field.

See [frontend architecture](docs/frontend-architecture.md) for process boundaries, persistence, and transport behavior.
