# Aria desktop architecture

## Chat-first renderer

The primary routes are `/chat` and `/settings`. Startup always enters chat, restoring the selected conversation or a welcome screen. Projects are never required. Chat layout, sidebar, conversation list/menus, welcome prompts, message rendering, composer, and settings are separate typed React components. Zustand supplies runtime chat status; the existing workspace store remains the single owner of all persisted application data.

The sidebar groups pinned/recent conversations by local calendar date, searches titles and messages, and supports rename/deletion. Below 900px it becomes a Radix dialog with focus management and Escape dismissal. Native Electron framing preserves macOS traffic lights and Windows controls. CSS tokens provide dark/light/system themes and reduced-motion support.

Chat operations live in `chatStore`, not message components. Submission creates a conversation only on first send, records the user message and pending assistant immediately, flushes persistence, then invokes the bridge. New drafts typed during submission are not cleared afterward. Each conversation can have one active response, and responses continue across navigation. Request/message/conversation IDs and monotonic sequences reject stale, duplicate, stopped, deleted, and superseded updates.

Retry/regeneration reuses the latest user turn and replaces only its assistant answer. Provider context contains the latest user message and at most 20 completed prior turns, bounded to 100,000 characters. Full local history is retained. Connection errors and incomplete streams preserve partial content and expose explicit retry.

Markdown uses react-markdown and remark-gfm without raw HTML execution. Code/message copying uses the existing clipboard bridge. HTTP(S) links use validated main-process opening. Remote images are not loaded. File attachments are intentionally absent until real content delivery exists.

## Managed NestJS service

Electron main launches the staged API after app readiness with `utilityProcess.fork`, using Electron’s embedded Node runtime. A private ready handshake reports an ephemeral loopback port. Main generates a per-launch bearer token; only main receives the port/token. The renderer never receives provider credentials from persisted settings, the internal token, or arbitrary network/process access.

The API preserves `/health`. Authenticated `/chat/capabilities` reports configuration and supported features. `/chat/stream` validates DTOs, applies server-owned system instructions, and streams through Vercel AI SDK. Official OpenAI endpoints use its native Responses provider with `store: false`; custom endpoints use the OpenAI-compatible Chat Completions provider. This avoids sending legacy `max_tokens` to modern OpenAI reasoning models. Missing setup returns an explicit service-unavailable response. Provider errors are sanitized and automatic generation retries are disabled.

Main validates named IPC operations and the sender, performs HTTP/SSE requests, decodes byte/frame boundaries, and forwards typed events. The renderer’s existing strict CSP, context isolation, sandbox, and disabled Node integration are retained. Stop aborts HTTP; NestJS propagates response disconnect to the provider. Main rejects mismatched IDs, missing sequences, malformed/oversized frames, and streams without a terminal event.

Unexpected process exit interrupts active requests. Settings offers explicit service restart; requests are never automatically replayed. Closing flushes partial replies and drafts before destroying the window. Application exit shuts down the utility process, with bounded termination fallback. Renderer reload also cancels outstanding requests and restores saved pending replies as interrupted.

Build/predev compiles the API and uses `pnpm deploy --prod` to stage a portable runtime in desktop build output. Only API distribution files and production dependencies are included. This supports repository production launches without a separate Node installation; installer packaging/signing remains separate.

## Provider configuration

Settings edits endpoint, model, key, and system instructions. Only transient password input exists in the renderer; input clears after submission. Main uses Electron 45’s asynchronous safeStorage APIs and writes encrypted key bytes to `provider.json` outside conversation storage. Availability/encryption/decryption failures produce actionable errors, never plaintext fallback. The settings getter returns configuration and source flags, never a key. Rotated encryption keys are re-encrypted when indicated by Electron.

Nonempty provider environment variables override saved values and are shown as environment-managed fields. Main passes effective configuration to the API through environment variables. The default endpoint is OpenAI’s `/v1` endpoint; model selection is explicit. A configured state does not imply valid credentials or a reachable provider. Test connection performs a short real request without creating a conversation and has a bounded timeout.

## Persistence and legacy compatibility

Application schema v2 adds project-independent conversations, messages, selected chat, welcome draft, pin state, per-conversation drafts, profile name, and chat sidebar preference. `aria-v2.json` is the current document. If absent, the validated `workspace-v1.json` is migrated once, retaining its original contents and all legacy records. Broken documents are copied to a recovery file. Pending/streaming messages restore as interrupted.

All persisted mutations use one debounced, serialized writer and an atomic temporary-file rename. The close handshake waits for saving and keeps the window open if saving fails. The 8 MB total bound and schema limits produce visible errors, with no silent history pruning. Provider configuration has its own main-owned serialized settings flow and is never copied into conversation data.

Legacy screens are lazily mounted under `/advanced/*`, accessed only through Advanced settings. Their project file boundaries, fixed read-only Git operations, manual task dependency checks, sample labels, and unavailable execution capabilities remain in place. Their adapters and keyboard shortcuts exist only while the legacy shell is mounted. Legacy data and sample data never become primary chat history. Workspace/legacy preferences remain separate from chat navigation preferences.

## Verification

Unit/component tests cover migration, save failures, key encryption/precedence, request validation, real SDK request construction against a local provider fixture, SSE framing, cancellation, process restart, late events, context bounds, composer keyboard/IME behavior, conversation management, safe Markdown, and existing legacy services.

Playwright launches actual Electron in built and Vite development modes. Tests cover first-run chat, secure settings, real NestJS streaming to the fixture provider, copying, history management, background replies, interruption/restart, close-time persistence, responsive dialogs, and legacy workflows. Screenshots are generated under desktop `.artifacts/screenshots`. CI defines macOS/Windows jobs; local macOS execution cannot establish Windows runtime acceptance. Live commercial-provider acceptance requires configured credentials and is reported separately from fixture testing.
