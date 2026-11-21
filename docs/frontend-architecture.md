# Aria desktop architecture

## Chat-first renderer

The primary routes are `/chat` and `/settings`. Startup always enters chat, restoring the selected conversation or a welcome screen. Projects are never required. Chat layout, sidebar, conversation list/menus, welcome prompts, message rendering, composer, and settings are separate typed React components. Zustand supplies runtime chat status; the existing workspace store remains the single owner of all persisted application data.

The sidebar groups pinned/recent conversations by local calendar date, searches titles and messages, and supports rename/deletion. Below 900px it becomes a Radix dialog with focus management and Escape dismissal. Native Electron framing preserves macOS traffic lights and Windows controls. CSS tokens provide dark/light/system themes and reduced-motion support.

Chat operations live in `chatStore`, not message components. Submission creates a conversation only on first send, records the user message and pending assistant immediately, flushes persistence, then invokes the bridge. New drafts typed during submission are not cleared afterward. Each conversation can have one active response, and responses continue across navigation. Request/message/conversation IDs and monotonic sequences reject stale, duplicate, stopped, deleted, and superseded updates.

Retry and regeneration reuse the latest user message. A retry requires a matching registry revision and confirmation that no billable child started. A fresh attempt uses current Settings. Provider context contains the latest user message and up to 20 completed prior turns, bounded to 100,000 characters. Attachment IDs belong to the submitted turn. Markdown supports safe links and copying. Binary previews use Aria's local asset protocol.

Desktop text chat renders charts and flowcharts from versioned JSON in top-level `aria-visual` Markdown fences. The renderer mounts a visual after the closing fence arrives and the payload passes the shared schema. Invalid or interrupted blocks expose their source for copying. Chart data, diagram connections, and locally rendered equations travel through the existing text stream and history. The existing artifact workflow handles downloadable chart files.

## Managed NestJS service

Electron main launches the staged API after app readiness with `utilityProcess.fork`, using Electron’s embedded Node runtime. A private parent-channel handshake installs the registry snapshot before reporting an ephemeral loopback port. Main generates a per-launch bearer token; only main receives the port/token. The renderer never receives provider credentials from persisted settings, the internal token, or arbitrary network/process access.

The authenticated `/chat/capabilities` endpoint reports configuration and revision. `/chat/stream` validates turn DTOs and delegates to Conductor. The primary model decides between a direct streamed answer, structured execution requests, and clarification. The same primary synthesizes the final result. Native OpenAI uses Responses with `store: false`. Compatible providers use Chat Completions. Provider calls have automatic retries disabled.

Main validates named IPC operations and the sender, performs HTTP/SSE requests, decodes byte/frame boundaries, and forwards typed events. The renderer’s existing strict CSP, context isolation, sandbox, and disabled Node integration are retained. Stop aborts HTTP; NestJS propagates response disconnect to the provider. Main rejects mismatched IDs, missing sequences, malformed/oversized frames, and streams without a terminal event.

Unexpected process exit interrupts active requests. Settings offers explicit service restart; requests are never automatically replayed. Closing flushes partial replies and drafts before destroying the window. Application exit shuts down the utility process, with bounded termination fallback. Renderer reload also cancels outstanding requests and restores saved pending replies as interrupted.

Build/predev compiles the API and uses `pnpm deploy --prod` to stage the service and its production dependencies. Installer builds materialize that same dependency graph in the application's resources directory. Compiled desktop code, renderer assets, built-in skills, and native helpers ship with Electron. The service uses Electron's embedded Node runtime.

## Desktop updates

Electron main checks public Aria releases and verifies the signed manifest, target metadata, and installer bytes. On Windows it also requires Authenticode trust and a pinned signing certificate. The renderer receives only update status and exposes a fixed action set through trusted IPC. Install and restart uses the existing renderer-save and service-shutdown handshake. [Release verification and trust setup](RELEASING.md)

## Registry and execution

Electron main persists the versioned model registry and encrypted credentials in `provider-v2.json`. It migrates prior defaults and keeps `provider.json` as a backup. Desktop environment configuration is an explicit import. Only ephemeral credential fields cross the renderer bridge into main. Main holds the private API token and sends the effective registry to the utility process over its parent channel. Catalog lookups cache briefly by endpoint and credential fingerprint. Settings refreshes discovery explicitly and discards stale responses after endpoint or key edits.

Registry identity combines the connection ID and exact provider model ID. Available model IDs come from authenticated discovery. Provider metadata and versioned official documentation supply capabilities and protocol descriptors. Settings can fill unknown capabilities for compatible IDs. Primary verification for a declaration is a bounded streaming function call tied to the exact connection, model, endpoint, and credential.

Conductor exposes progressively loaded operations with exact targets, capabilities, and output contracts. The execution engine validates arguments, dependencies, ownership, current policy, and caller scope. Primary, delegated, and program work share a turn budget. Independent operations use the scheduler. An uncertain effect fences further attempts until reconciliation. Pre-dispatch errors can return to the primary for a different authorized approach. Web search and page reads use Electron browser tools when the user enables AI browsing. Direct replies have no activity panel.

## Attachments, artifacts, and voice

Main resolves submitted attachment IDs against the saved user turn. It stages validated files with `POST /chat/:requestId/attachments`. NestJS accepts only run-scoped attachment and dependency references from tools. Activity and artifact references arrive over SSE. Main downloads binary results from the authenticated run-scoped endpoint, checks the size and MIME type, and stores them under UUIDs in the local `media/` directory. The renderer receives metadata. The asset protocol accepts only known IDs and supports byte ranges for local playback. Conversation and draft references govern pruning.

The **Share full screen** button opens a native display chooser on macOS and Windows. Electron main captures one image after the user selects a display and attaches it to the originating chat draft. macOS requires Screen & System Audio Recording permission. The composer previews the image locally before the user sends it through the usual attachment flow.

The authenticated loopback `/voice` WebSocket connects to the registry's GPT-Live profile using client delegation. The renderer requests microphone permission after an explicit action and sends 24 kHz mono PCM16 through Electron main. NestJS correlates each delegation ID and timestamp with transcript context and dispatches it once to the configured primary. It sends the result back for speech and streams delegated activity and artifacts to the conversation. Captions, assistant audio, mute, and interruption use the existing voice lifecycle. Ending voice aborts delegated work. Session startup, audio queues, transcripts, and close are bounded.

## Persistence and legacy compatibility

Application schema v3 adds media asset references, historical operation metadata, draft attachments, timestamped voice fragments, and bounded execution records to project-independent chat history. `aria-v3.json` is the current document. If absent, `aria-v2.json` is migrated first, falling back to `workspace-v1.json`. Original documents and legacy records remain intact. Broken documents are copied to a recovery file. Pending/streaming messages restore as interrupted.

All persisted mutations use one debounced, serialized writer and an atomic temporary-file rename. The close handshake waits for saving and keeps the window open if saving fails. The 8 MB conversation-JSON bound and schema limits produce visible errors, with no silent history pruning. Provider configuration has its own main-owned serialized settings flow and is never copied into conversation data.

Legacy screens are lazily mounted under `/advanced/*`, accessed only through Advanced settings. Their project file boundaries, fixed read-only Git operations, manual task dependency checks, sample labels, and unavailable execution capabilities remain in place. Their adapters and keyboard shortcuts exist only while the legacy shell is mounted. Legacy data and sample data never become primary chat history. Workspace/legacy preferences remain separate from chat navigation preferences.

## Verification

Unit/component tests cover migration, save failures, encrypted registry migration and import, request validation, real SDK request construction against a local provider fixture, SSE framing, cancellation, process restart, late events, context bounds, composer keyboard/IME behavior, conversation management, safe Markdown, provider catalog races, media storage/migration, draft credentials, media APIs, GPT-Live protocol/authentication, and existing legacy services.

Playwright launches actual Electron in built and Vite development modes. Tests cover first-run chat, secure settings, real NestJS streaming to the fixture provider, copying, history management, background replies, interruption/restart, close-time persistence, responsive dialogs, and legacy workflows. Screenshots are generated under desktop `.artifacts/screenshots`. CI defines macOS/Windows jobs; local macOS execution cannot establish Windows runtime acceptance. Live commercial-provider acceptance requires configured credentials and is reported separately from fixture testing.

## Web and browser

The ordinary chat workspace stays mounted in Chat, Split, and Browser modes. Browser chrome runs in the trusted renderer. Electron main positions the selected `WebContentsView` inside the measured slot and suspends the native view while trusted dialogs cover it. Personal tabs can preview a page link or selection before inserting it into the draft. AI tabs belong to one conversation and use isolated memory-only sessions.

The managed API startup handshake transfers a private message port. For an active chat turn, Conductor validates the selected browser tool, its inputs and dependencies. The utility process sends a request with the active run ID, conversation, step and generation. Electron main checks that binding, executes the browser operation, and sends the matched response back over the port. Conductor supplies the evidence to the same primary model. The existing authenticated SSE path carries activity, citations, and the final answer to main, which forwards validated events to the renderer. Native browser tools are absent from standalone and Live Voice runs.

`web-settings-v1.json` stores web policy. The browser-only migration removes legacy Brave search credentials. `browser-state-v1.json` stores bookmarks and optional personal history and restore URLs. Chromium handles cookie/site storage in its own partition. No existing settings or conversation file is rewritten as part of web setup. Source metadata is optional in existing conversation history. See [web and browser security](web-browser-security.md).

## Conductor tools and skills

Ordinary chat makes a direct primary-model request with a compact capability summary and discovery controls. The model may ask for authorized metadata, load a small set of schemas, call a tool, and continue with its correlated result. Conductor validates every operation against the current registry and uses one scoped execution engine for web, attachments, artifacts, and exact delegated model targets. Tool metadata and selected schemas stay in memory for the turn. Expanded chat activity displays runtime state and safe summaries through the existing event stream.

Settings → Tools shows availability and permissions. Aria discovery is the default. Native OpenAI Tool Search is an explicit mode verified for the configured primary, endpoint and credential. It uses Responses client search, namespaces, and stateless continuation. Changing the verified configuration requires a new verification. Standalone users may opt in to the official Responses route with `ARIA_TOOL_DISCOVERY=openai-responses`.

Electron main derives outgoing history from saved turns and carries privacy metadata across compatible revisions. The turn budget can compact completed history while retaining the user’s latest request and active tool pairs. Direct calls and program children share the same privacy checks. Evidence and source lists persist even when older activity exceeds the display cap.

Computer Use runs through the desktop capability port. Chat shows an expandable panel for the active session, the latest authorized image, action history, and supervision. The managed browser attaches its interactive Electron view during takeover. Virtual desktop takeover uses a local-only preview and an input channel available to the trusted application renderer. Local desktop takeover leaves the user in control of the approved display. Settings manages the durable grant, and each active chat starts its own input lease.

Settings → Skills imports approved Agent Skills directories or single-root ZIPs. Aria stores approved copies by content digest. A turn can read instructions and supported UTF-8 files under `references/` and `assets/` one resource at a time. Imported instructions and resources are untrusted task content and restrict onward transfer. Script files remain inert. Version approvals, tool switches, and consent records live under the desktop profile. Skill management uses trusted IPC. Only the managed API receives the scoped capability port.

Set `ARIA_RUN_MODEL_EVALS=1` with an authorized `OPENAI_API_KEY` and `OPENAI_MODEL`, then run `pnpm --filter @aria/api test -- tool-intelligence.test.ts` to evaluate direct answers, tool selection, and skill selection against the configured model. Set `ARIA_TOOL_DISCOVERY=openai-responses` for the native evaluation. The deterministic suites require no credentials.

The local chat benchmark used 20 warm turns with the same fixture, browser policy, and delegates as the baseline. A greeting request fell from 21,021 to 4,447 bytes. Median and p95 time to first delta fell from 10.4/13.3 ms to 8.1/9.2 ms. Warm turns made one primary request and produced zero tool activity in both runs. These figures measure the local fixture.

## Execution and knowledge

Desktop text chat extends the Part 1 capability bridge with conversation-scoped operations for offline Shell, local and hosted retrieval, reviewed skill execution, and artifact publication. The desktop runtime opens its SQLite index and journal lazily. Ordinary chat remains independent of the execution substrate. See [execution and knowledge](execution-knowledge-runtime.md) for setup and verification.
