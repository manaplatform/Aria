# Aria desktop architecture

## Chat-first renderer

The primary routes are `/chat` and `/settings`. Startup always enters chat, restoring the selected conversation or a welcome screen. Projects are never required. Chat layout, sidebar, conversation list/menus, welcome prompts, message rendering, composer, and settings are separate typed React components. Zustand supplies runtime chat status; the existing workspace store remains the single owner of all persisted application data.

The sidebar groups pinned/recent conversations by local calendar date, searches titles and messages, and supports rename/deletion. Below 900px it becomes a Radix dialog with focus management and Escape dismissal. Native Electron framing preserves macOS traffic lights and Windows controls. CSS tokens provide dark/light/system themes and reduced-motion support.

Chat operations live in `chatStore`, not message components. Submission creates a conversation only on first send, records the user message and pending assistant immediately, flushes persistence, then invokes the bridge. New drafts typed during submission are not cleared afterward. Each conversation can have one active response, and responses continue across navigation. Request/message/conversation IDs and monotonic sequences reject stale, duplicate, stopped, deleted, and superseded updates.

Retry/regeneration reuses the latest user turn and replaces only its assistant answer. Provider context contains the latest user message and at most 20 completed prior turns, bounded to 100,000 characters. Full local history is retained. Connection errors and incomplete streams preserve partial content and expose explicit retry.

Markdown uses react-markdown and remark-gfm without raw HTML execution. Code/message copying uses the existing clipboard bridge. HTTP(S) links use validated main-process opening. Remote images are not loaded. Image/reference and audio-transcription attachments use explicit native pickers; text chat does not silently receive media content.

## Managed NestJS service

Electron main launches the staged API after app readiness with `utilityProcess.fork`, using Electron’s embedded Node runtime. A private ready handshake reports an ephemeral loopback port. Main generates a per-launch bearer token; only main receives the port/token. The renderer never receives provider credentials from persisted settings, the internal token, or arbitrary network/process access.

The API preserves `/health`. Authenticated `/chat/capabilities` reports configuration and supported features. `/chat/stream` validates DTOs, applies server-owned system instructions, and streams through Vercel AI SDK. Official OpenAI endpoints use its native Responses provider with `store: false`; custom endpoints use the OpenAI-compatible Chat Completions provider. This avoids sending legacy `max_tokens` to modern OpenAI reasoning models. Missing setup returns an explicit service-unavailable response. Provider errors are sanitized and automatic generation retries are disabled.

Main validates named IPC operations and the sender, performs HTTP/SSE requests, decodes byte/frame boundaries, and forwards typed events. The renderer’s existing strict CSP, context isolation, sandbox, and disabled Node integration are retained. Stop aborts HTTP; NestJS propagates response disconnect to the provider. Main rejects mismatched IDs, missing sequences, malformed/oversized frames, and streams without a terminal event.

Unexpected process exit interrupts active requests. Settings offers explicit service restart; requests are never automatically replayed. Closing flushes partial replies and drafts before destroying the window. Application exit shuts down the utility process, with bounded termination fallback. Renderer reload also cancels outstanding requests and restores saved pending replies as interrupted.

Build/predev compiles the API and uses `pnpm deploy --prod` to stage a portable runtime in desktop build output. Only API distribution files and production dependencies are included. This supports repository production launches without a separate Node installation; installer packaging/signing remains separate.

## Provider configuration

Settings exposes a fixed OpenAI provider dropdown, editable endpoint/key/instructions, and fetched model defaults for each operation. Shared types retain the legacy Chat `model` alias while adding the provider ID, model catalog descriptors, and per-operation defaults. Older settings resolve to OpenAI with their existing model as the Chat default. Only transient password input exists in the renderer; input clears after submission. Main uses Electron 45’s asynchronous safeStorage APIs and writes encrypted key bytes to `provider.json` outside conversation storage. Availability/encryption/decryption failures produce actionable errors, never plaintext fallback. The settings getter returns configuration and source flags, never a key. Rotated encryption keys are re-encrypted when indicated by Electron.

Nonempty provider environment variables override saved values and are shown as environment-managed fields. Main passes effective configuration to the API through environment variables. The default endpoint is OpenAI’s `/v1` endpoint; model selection is explicit. `OPENAI_MODEL` overrides only the Chat default. The guarded `POST /providers/models` endpoint accepts main-resolved preview credentials and calls the provider’s authenticated `GET /models` without requiring a selected model or persisting a draft key. Responses contain only catalog descriptors. Cache entries use a connection/key fingerprint, expire after five minutes, and are discarded on discovery failure. Discovery in Settings explicitly refreshes the catalog. Both saving defaults and generation validate membership; recognized incompatible model families are excluded from that operation’s dropdown, while unclassified returned IDs remain available as Other models. Late discovery responses are ignored after connection changes. A configured state does not imply valid credentials or a reachable provider. Test connection performs a short real request without creating a conversation and has a bounded timeout.

## Media and GPT-Live

`POST /media/generate` is authenticated multipart input with a validated operation/model/prompt/voice and bounded files. NestJS owns provider image generation/edits, Speech API or Realtime narration, and file transcription. It returns bounded PNG/WAV bytes or transcript JSON. Main stores binary results separately and emits typed chat events containing asset metadata. Stop aborts the private HTTP request and propagates upstream; retries are explicit and preserve request choices. Generation uses a five-minute timeout and no automatic retries.

Media files and small metadata sidecars live in a main-owned `media/` directory with UUID identifiers. Native imports validate size and file signatures. The `aria-media://asset/<uuid>` handler accepts only known local assets, supports byte ranges, and never accepts filesystem paths. The CSP permits this scheme for image/audio previews while retaining sandboxing and blocking arbitrary renderer networking. Saving conversation deletion precedes pruning of assets no longer referenced in messages, operation inputs, or drafts.

The authenticated loopback `/voice` WebSocket accepts only typed start/audio/mute/end commands. NestJS opens the configured endpoint’s `/live/sessions` connection, sends `session.start` with the selected GPT-Live model, Chat Responses backend, history, voice, and `store: false`, and forwards only validated captions/audio/lifecycle events. Configured system instructions apply to the Live session and its Responses backend; tools are disabled. The raw protocol is used because the installed AI SDK’s experimental Live adapter does not support Responses delegation.

The renderer obtains audio only after an explicit start action. Permission checks allow microphone-only requests from the application’s main frame. An external same-origin AudioWorklet resamples capture to 24 kHz mono PCM16; Electron main relays bounded chunks through IPC, keeping API keys and the private session token out of the renderer. Audio queues, payload sizes, transcripts, startup, and graceful close are bounded. Live session changes require ending the session; leaving chat, switching conversations, failure, and shutdown release microphone/audio resources. Sessions never reconnect automatically.

Live user/assistant captions retain independent timestamped fragments, since the protocol is full duplex and supplies no conversational-turn completion event. Only assistant audio is collected into a WAV asset; microphone bytes are forwarded transiently. History migration restores interrupted sessions without restarting microphone capture. Physical-device echo handling and commercial GPT-Live acceptance require separate runtime checks.

## Persistence and legacy compatibility

Application schema v3 adds media asset references, reproducible operation metadata, draft attachments, and timestamped voice fragments to project-independent chat history. `aria-v3.json` is the current document. If absent, `aria-v2.json` is migrated first, falling back to `workspace-v1.json`. Original documents and legacy records remain intact. Broken documents are copied to a recovery file. Pending/streaming messages restore as interrupted.

All persisted mutations use one debounced, serialized writer and an atomic temporary-file rename. The close handshake waits for saving and keeps the window open if saving fails. The 8 MB conversation-JSON bound and schema limits produce visible errors, with no silent history pruning. Provider configuration has its own main-owned serialized settings flow and is never copied into conversation data.

Legacy screens are lazily mounted under `/advanced/*`, accessed only through Advanced settings. Their project file boundaries, fixed read-only Git operations, manual task dependency checks, sample labels, and unavailable execution capabilities remain in place. Their adapters and keyboard shortcuts exist only while the legacy shell is mounted. Legacy data and sample data never become primary chat history. Workspace/legacy preferences remain separate from chat navigation preferences.

## Verification

Unit/component tests cover migration, save failures, key encryption/precedence, request validation, real SDK request construction against a local provider fixture, SSE framing, cancellation, process restart, late events, context bounds, composer keyboard/IME behavior, conversation management, safe Markdown, provider catalog races, media storage/migration, draft credentials, media APIs, GPT-Live protocol/authentication, and existing legacy services.

Playwright launches actual Electron in built and Vite development modes. Tests cover first-run chat, secure settings, real NestJS streaming to the fixture provider, copying, history management, background replies, interruption/restart, close-time persistence, responsive dialogs, and legacy workflows. Screenshots are generated under desktop `.artifacts/screenshots`. CI defines macOS/Windows jobs; local macOS execution cannot establish Windows runtime acceptance. Live commercial-provider acceptance requires configured credentials and is reported separately from fixture testing.
