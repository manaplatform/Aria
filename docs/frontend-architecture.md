# Aria desktop architecture

## Chat-first renderer

The primary routes are `/chat` and `/settings`. Startup always enters chat, restoring the selected conversation or a welcome screen. Projects are never required. Chat layout, sidebar, conversation list/menus, welcome prompts, message rendering, composer, and settings are separate typed React components. Zustand supplies runtime chat status; the existing workspace store remains the single owner of all persisted application data.

The sidebar groups pinned/recent conversations by local calendar date, searches titles and messages, and supports rename/deletion. Below 900px it becomes a Radix dialog with focus management and Escape dismissal. Native Electron framing preserves macOS traffic lights and Windows controls. CSS tokens provide dark/light/system themes and reduced-motion support.

Chat operations live in `chatStore`, not message components. Submission creates a conversation only on first send, records the user message and pending assistant immediately, flushes persistence, then invokes the bridge. New drafts typed during submission are not cleared afterward. Each conversation can have one active response, and responses continue across navigation. Request/message/conversation IDs and monotonic sequences reject stale, duplicate, stopped, deleted, and superseded updates.

Retry and regeneration reuse the latest user message. A retry requires a matching registry revision and confirmation that no billable child started. A fresh attempt uses current Settings. Provider context contains the latest user message and up to 20 completed prior turns, bounded to 100,000 characters. Attachment IDs belong to the submitted turn. Markdown supports safe links and copying. Binary previews use Aria's local asset protocol.

## Managed NestJS service

Electron main launches the staged API after app readiness with `utilityProcess.fork`, using Electron’s embedded Node runtime. A private parent-channel handshake installs the registry snapshot before reporting an ephemeral loopback port. Main generates a per-launch bearer token; only main receives the port/token. The renderer never receives provider credentials from persisted settings, the internal token, or arbitrary network/process access.

The authenticated `/chat/capabilities` endpoint reports configuration and revision. `/chat/stream` validates turn DTOs and delegates to Conductor. The primary model decides between a direct streamed answer, structured execution requests, and clarification. The same primary synthesizes the final result. Native OpenAI uses Responses with `store: false`. Compatible providers use Chat Completions. Provider calls have automatic retries disabled.

Main validates named IPC operations and the sender, performs HTTP/SSE requests, decodes byte/frame boundaries, and forwards typed events. The renderer’s existing strict CSP, context isolation, sandbox, and disabled Node integration are retained. Stop aborts HTTP; NestJS propagates response disconnect to the provider. Main rejects mismatched IDs, missing sequences, malformed/oversized frames, and streams without a terminal event.

Unexpected process exit interrupts active requests. Settings offers explicit service restart; requests are never automatically replayed. Closing flushes partial replies and drafts before destroying the window. Application exit shuts down the utility process, with bounded termination fallback. Renderer reload also cancels outstanding requests and restores saved pending replies as interrupted.

Build/predev compiles the API and uses `pnpm deploy --prod` to stage a portable runtime in desktop build output. Only API distribution files and production dependencies are included. This supports repository production launches without a separate Node installation; installer packaging/signing remains separate.

## Registry and execution

Electron main persists the versioned model registry and encrypted credentials in `provider-v2.json`. It migrates prior defaults and keeps `provider.json` as a backup. Desktop environment configuration is an explicit import. Only ephemeral credential fields cross the renderer bridge into main. Main holds the private API token and sends the effective registry to the utility process over its parent channel. Catalog lookups cache briefly by endpoint and credential fingerprint. Settings refreshes discovery explicitly and discards stale responses after endpoint or key edits.

Registry identity combines the connection ID and exact provider model ID. Available model IDs come from authenticated discovery. Provider metadata and versioned official documentation supply capabilities and protocol descriptors. Settings can fill unknown capabilities for compatible IDs. Primary verification for a declaration is a bounded streaming function call tied to the exact connection, model, endpoint, and credential.

Conductor snapshots allowed models and tools per turn, exposing each eligible operation's exact target, capability, and output to the primary. The primary delegates image creation and editing to an enabled image model using these references. Its execution engine checks structured step arguments, resolves references, validates dependencies and scope, and runs up to three independent steps at once. Delegates receive only the supplied task and authorized inputs. A target validation error before dispatch can be corrected by the primary when an eligible operation exists. A failed invocation blocks replacement for that capability within the run. Hosted Web Search requires an eligible OpenAI backing model and explicit connection permission. The engine returns source provenance and opaque artifact references. Direct replies have no activity panel.

## Attachments, artifacts, and voice

Main resolves submitted attachment IDs against the saved user turn. It stages validated files with `POST /chat/:requestId/attachments`. NestJS accepts only run-scoped attachment and dependency references from tools. Activity and artifact references arrive over SSE. Main downloads binary results from the authenticated run-scoped endpoint, checks the size and MIME type, and stores them under UUIDs in the local `media/` directory. The renderer receives metadata. The asset protocol accepts only known IDs and supports byte ranges for local playback. Conversation and draft references govern pruning.

The authenticated loopback `/voice` WebSocket connects to the registry's GPT-Live profile using client delegation. The renderer requests microphone permission after an explicit action and sends 24 kHz mono PCM16 through Electron main. NestJS correlates each delegation ID and timestamp with transcript context and dispatches it once to the configured primary. It sends the result back for speech and streams delegated activity and artifacts to the conversation. Captions, assistant audio, mute, and interruption use the existing voice lifecycle. Ending voice aborts delegated work. Session startup, audio queues, transcripts, and close are bounded.

## Persistence and legacy compatibility

Application schema v3 adds media asset references, historical operation metadata, draft attachments, timestamped voice fragments, and bounded execution records to project-independent chat history. `aria-v3.json` is the current document. If absent, `aria-v2.json` is migrated first, falling back to `workspace-v1.json`. Original documents and legacy records remain intact. Broken documents are copied to a recovery file. Pending/streaming messages restore as interrupted.

All persisted mutations use one debounced, serialized writer and an atomic temporary-file rename. The close handshake waits for saving and keeps the window open if saving fails. The 8 MB conversation-JSON bound and schema limits produce visible errors, with no silent history pruning. Provider configuration has its own main-owned serialized settings flow and is never copied into conversation data.

Legacy screens are lazily mounted under `/advanced/*`, accessed only through Advanced settings. Their project file boundaries, fixed read-only Git operations, manual task dependency checks, sample labels, and unavailable execution capabilities remain in place. Their adapters and keyboard shortcuts exist only while the legacy shell is mounted. Legacy data and sample data never become primary chat history. Workspace/legacy preferences remain separate from chat navigation preferences.

## Verification

Unit/component tests cover migration, save failures, encrypted registry migration and import, request validation, real SDK request construction against a local provider fixture, SSE framing, cancellation, process restart, late events, context bounds, composer keyboard/IME behavior, conversation management, safe Markdown, provider catalog races, media storage/migration, draft credentials, media APIs, GPT-Live protocol/authentication, and existing legacy services.

Playwright launches actual Electron in built and Vite development modes. Tests cover first-run chat, secure settings, real NestJS streaming to the fixture provider, copying, history management, background replies, interruption/restart, close-time persistence, responsive dialogs, and legacy workflows. Screenshots are generated under desktop `.artifacts/screenshots`. CI defines macOS/Windows jobs; local macOS execution cannot establish Windows runtime acceptance. Live commercial-provider acceptance requires configured credentials and is reported separately from fixture testing.
