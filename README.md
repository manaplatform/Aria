# Aria

Aria is a desktop-first AI chatbot built with Electron, React, TypeScript, Tailwind, Radix UI, NestJS, and Vercel AI SDK.

## Start

Requires Node.js 22.12+ and pnpm 9.12.3 for development.

```sh
pnpm install
pnpm dev:desktop
```

Aria opens directly into chat. In **Settings → Model connection**, select **OpenAI**, enter your API key, and choose **Load models**. Select defaults from the fetched model dropdowns, then choose **Save & reconnect**. Custom OpenAI-compatible endpoints remain supported. Use **Test connection** to send a short provider probe. A configured key/model is distinguished from a tested connection.

Electron starts and stops the NestJS API automatically. You do not need to create a project or launch a server separately. The built desktop runs its staged API using Electron’s embedded Node runtime.

API keys saved in Settings are encrypted in the main process using the operating system’s credential protection. Encryption failures never fall back to plaintext storage. Keys are not returned by the settings API or included in conversation data.

## Configuration

Settings supports the OpenAI provider, custom endpoint, API key, system instructions, and separate Chat, Image, Speech, Transcribe, and Live Voice model defaults. The default endpoint is `https://api.openai.com/v1`. Models are fetched from the endpoint’s authenticated `/models` API; IDs cannot be entered manually. New defaults stay unset until selected. Recognized model families are grouped by operation; unclassified IDs appear under **Other models**. Catalog membership is checked before generation, and a disappeared model requires reselection.

Official OpenAI endpoints use the native Responses API, including support for reasoning models such as GPT-6 Luna. Other endpoints use the OpenAI-compatible Chat Completions adapter.

Nonempty environment variables override saved settings: `OPENAI_API_KEY`, `OPENAI_MODEL` (the Chat default), `OPENAI_BASE_URL`, and `ARIA_SYSTEM_PROMPT`. Media defaults are configured in Settings. Development reads the repository’s `.env`; `.env.example` documents the optional variables. Leave them blank to configure Aria through Settings. Changing backend source requires restarting the desktop development command to restage the API.

No production provider credentials are included. Automated tests use an explicitly local fixture provider; a live-provider smoke test requires your own configured credentials.

## Conversations

- Chat immediately after provider setup, with real streaming, Stop, retry/regenerate, safe Markdown, tables, and message/code copying.
- Search titles and message text, rename, pin, and delete conversations through the sidebar.
- Preserve per-conversation drafts and continue receiving replies when switching chats.
- Use Cmd/Ctrl+Shift+O for New Chat, Cmd/Ctrl+K for search, and Cmd/Ctrl+L to focus the composer.
- Choose dark, light, or system appearance. Conversations, profile name, and sidebar preference stay on this device.

The provider receives the newest user message and up to 20 recent completed turns, bounded to 100,000 characters. Full local history remains intact. Interrupted streams retain their partial text and require explicit retry; restarting the service never replays a message automatically. Media inputs and outputs are excluded from the text-chat context; their prompts, selected models, and files remain in local history.

## Images, speech, transcription, and live voice

Use the composer’s mode and model selectors to switch operations. Quick model changes affect subsequent requests without replacing Settings defaults. Model discovery does not verify every capability of a custom server: it must implement the corresponding OpenAI-compatible API, and unsupported operations produce an error without changing endpoints or models.

- **Image:** generate one PNG from a prompt, or attach up to four PNG/JPEG/WebP references (20 MB each) to edit. **Use image** reuses a generated image as a reference. Mask editing is not included.
- **Speech:** type up to 4,096 characters, select a model/voice, and generate playable/downloadable WAV audio. Speech API models use `/audio/speech`; Realtime models use the documented audio response workflow. `marin` is the initial voice where supported; legacy `tts-*` models initially use `alloy`. The older Speech API model families are [scheduled to retire January 6, 2027](https://developers.openai.com/api/docs/deprecations#2026-10-01-text-to-speech-models).
- **Transcribe:** attach one FLAC, MP3, MP4/M4A, MPEG/MPGA, OGG, WAV, or WebM audio file up to 25 MB. Its transcript is saved in the conversation.
- **Live Voice:** open **Live voice options**, choose a GPT-Live model and Chat backend model, then start the microphone session. Hands-free voice includes captions, interruption, mute, and end controls. Starting requires microphone permission. Switching conversations, leaving chat, or closing the app ends the session. No automatic reconnection occurs.

Live voice uses [OpenAI GPT-Live](https://developers.openai.com/api/docs/guides/live) with Responses delegation and no enabled tools. Local history retains transcript fragments/timestamps and the assistant’s generated audio, without saving microphone recordings. The provider session uses `store: false`. Provider billing/data policies still apply to content sent for generation.

Media is saved separately under the application-data `media/` directory and exposed through opaque local asset URLs. Download uses a native save dialog. Generated files have a 64 MB local bound; requests have a five-minute bound. Deleting a conversation removes its associated media after history saves successfully, retaining any files reused elsewhere. Stop and explicit retry are available; retries retain the original operation, model, options, and references.

Video generation is deferred because OpenAI [retired the Videos API](https://developers.openai.com/api/docs/deprecations#2026-03-24-sora-2-video-generation-models-and-videos-api). Voice cloning and microphone recording are not included.

## Legacy workspace

**Settings → Advanced → Open legacy workspace** retains existing projects, file browsing, drafts, manual tasks/plans, and clearly labelled sample workflows. These screens live under `/advanced/*` and provide **Return to chat**. Real coding execution and orchestration remain unavailable, as before.

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

The optional standalone API remains available through `pnpm dev:api`. It binds to loopback, defaults to port 3000, and preserves `GET /health`. Chat endpoints require `ARIA_INTERNAL_TOKEN`; the desktop generates its own private token and ephemeral port automatically.

See [frontend architecture](docs/frontend-architecture.md) for process boundaries, persistence, and transport behavior.
