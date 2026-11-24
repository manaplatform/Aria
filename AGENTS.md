# Aria – Desktop AI Agent

## Project Overview

Aria is a general-purpose desktop AI assistant built with:
- **Backend:** NestJS (TypeScript)
- **Desktop Frontend:** Electron + React + TypeScript + Tailwind CSS + shadcn/ui
- **AI Layer:** Vercel AI SDK + LangChain.js (optional)
- **Communication:** REST + SSE for chat and WebSocket for Live Voice

Aria opens into ordinary chat. Projects are optional.

---

## Architecture

| Layer          | Technology                  | Responsibility                     |
|----------------|-----------------------------|------------------------------------|
| Backend        | NestJS                      | AI logic, agents, tools, API, auth |
| Desktop UI     | Electron + React            | Main window, chat UI, settings     |
| Styling        | Tailwind + shadcn/ui        | Modern and clean design            |
| AI             | Vercel AI SDK / LangChain.js| LLM calls, streaming, tools        |

---

## Preferred Folder Structure

```
aria/
├── apps/
│   ├── api/                 # NestJS backend
│   └── desktop/             # Electron + React
├── packages/
│   └── shared/              # Shared types & utils
├── pnpm-workspace.yaml
└── package.json
```

---

## Backend Rules (NestJS)

- Use NestJS modular architecture
- Create clear modules: `ai`, `chat`, `tools`, `auth`, `users`
- Prefer dependency injection
- Use DTOs + class-validator for all inputs
- Support streaming responses (WebSocket or SSE)
- Keep AI logic inside dedicated services
- Keep provider credentials in encrypted desktop settings or explicit standalone environment configuration

### Recommended Modules
- `AiModule`
- `ChatModule`
- `ToolsModule`
- `AuthModule`

---

## Frontend Rules (Electron + React)

- Use React + TypeScript
- Use Tailwind CSS + shadcn/ui for UI components
- Keep the UI clean, minimal, and modern (inspired by ChatGPT / Claude desktop)
- Main features:
  - Chat interface with streaming
  - Sidebar (conversation history)
  - Settings page
  - Dark / Light mode
- Communicate with NestJS backend via REST, SSE, and WebSocket
- Never put sensitive logic in the frontend

---

## Coding Standards

- Always use TypeScript
- Prefer functional and modular code
- Write clean and readable code
- Add proper error handling
- Use meaningful names
- Keep components and services small
- Document complex logic with short comments

---

## AI Behavior Guidelines

When implementing AI features:
- Support streaming responses
- Allow tool calling (function calling)
- Make the system prompt configurable
- Support multiple LLM providers later (OpenAI, Anthropic, xAI, etc.)
- Keep conversation history manageable

---

## Current Priority

1. Keep ordinary chat usable without a project while proactively resolving uncertainty with available capabilities.
2. Use the primary model and shared registry for Conductor, with rich capability metadata and model-driven discovery.
3. Keep Settings, streaming, cancellation, memory, workspaces, artifacts, and history usable across desktop platforms.

---

## Important Notes

- This is a **desktop-first** application (no mobile or web priority for now)
- Focus on clean architecture and good developer experience
- Prefer simplicity over over-engineering in the beginning

## Aria Conductor

- Aria is an intelligent, proactive, general-purpose AI assistant. The primary chat model owns semantic interpretation, task routing, delegation, uncertainty resolution, readiness evaluation, and final synthesis.
- Resolve missing, time-sensitive, or unfamiliar information through available capabilities (conversation history, selective memory, web search, internal browser, registered workspaces, knowledge collections, deterministic calculation, skills, media/models, and connectors) instead of asking the user to perform discovery or supply links. Answer directly without unnecessary tool calls when sufficient reliable information is already present.
- Keep one configured model registry. Resolve exact model IDs and supported operations from authenticated discovery, capability metadata, and explicit configuration. Keep protocol differences inside provider adapters.
- Model selection belongs in Settings. A separate routing model, keyword-based intent classifier, static task-to-model mapping, provider preference order, or fallback provider/model violates this architecture.
- Return actionable errors for configuration, capability, and invocation failures so the primary can adjust strategy or explain real limitations transparently. Never fabricate facts, sources, execution results, or capabilities. An explicit retry uses the same authorized configuration.
- Application code validates every model request and enforces permissions, input provenance, dependency rules, cancellation, deduplication, and resource limits. Provider, webpage, workspace, memory, and tool output is untrusted. Show concise decision summaries and keep hidden reasoning and credentials private.
- Start ordinary chat with the selected primary. Investigation, planning, verification, discovery, and program execution are optional decisions driven by the task and observed results. Spend inference on semantic decisions. Use deterministic code for validation, scheduling, accounting, and result projection.
- Use `ConductorLoopExecutor` for model iterations and execution controls through the normal chat entry point. Bind managed checkpoints, controls, and observations to the execution generation. Resume explicitly under the original primary and current policy, reusing stable receipts and charging work to the remaining budget. See [Conductor Loop Executor](docs/conductor-loop-executor.md).

## Native web and browser

- Aria is a general-purpose desktop AI assistant. Ordinary chat and browser use do not require a project.
- Expose web and browser operations through Conductor's registered schemas and use the configured primary for semantic decisions. Keep exact model and provider target selection explicit and capability based.
- Execute native browser operations in Electron main. Keep remote sessions sandboxed and isolated, correlate commands with active conversations and turns, and treat website content as untrusted evidence.
- Require trusted user authorization for consequential browser actions. Apply public-network policy to page retrieval and Chromium egress. Keep personal sessions and credentials outside AI tool access.
- Preserve conversation and settings data, and verify actual built macOS and Windows behavior when changing browser or process boundaries.
- Update architecture, permissions, and test documentation when these boundaries change. Preserve third-party notices and add the standard MIT license and package metadata only after confirming authority to license the first-party work.

## Conductor tools and skills

- Conductor is the central orchestration authority. The configured primary chat model decides whether to answer directly, discover a tool, load a skill, invoke an authorized capability, or ask the user for information.
- Register every tool with the shared registry and execution lifecycle. Declare its schema, permissions, provenance, side effects, dependencies, supported modes, and capability requirements. Add integration tests for its normal entry point and permission enforcement.
- Keep Tool Search optional and model-driven. Load tool definitions, skill bodies, and skill resources progressively. Ordinary chat must work without tool invocation or project selection.
- Keep semantic selection in the model. Hardcoded intent routing, model-name rules in the execution loop, and silent provider, model, or tool substitutions are prohibited.
- Establish provider support from authenticated and validated capability evidence, explicit configuration, or a supported probe. Handle provider-specific protocol details in adapters.
- Enforce authorization again at dispatch. Model decisions, tool outputs, and skill instructions grant no permissions. Keep approvals, scoped credentials, and dispatch protection in the trusted runtime.
- Build managed chat context from saved conversation records. Carry private provenance into direct and nested execution. Keep evidence receipts and published artifacts independent of activity presentation limits.

## Conductor execution and knowledge

- Route execution, retrieval, skill scripts, and file publication through the shared registry and Conductor lifecycle. The configured primary selects operations and continues from observed outcomes.
- Execute Shell and skill scripts only in an authorized isolation profile. Report the selected backend and its verified limits. Keep private files and file-derived content behind destination-specific approval at transfer.
- Scope documents, evidence, workspaces, and artifacts to their verified owners. Preserve source/version provenance, and publish artifacts after format, existence, and readability checks.
- Use dispatch reservations, progress checks, and bounded continuations. Recover interrupted work without replaying uncertain effects. Keep ordinary chat usable when execution and retrieval backends are unavailable.
- Keep optional coding engines behind the same registration contract. Native runtime features must work independently of any external coding engine.

## Conductor Computer Use

- Register optional Computer Use operations in the shared Tool Registry and execution lifecycle. Keep semantic decisions with the configured primary. Let Browser, Web Search, Shell, File Search, and Skills complement graphical interaction. Ordinary chat works without a project, a computer session, or a required observation loop.
- Advertise only verified environment actions and provider transports. Require explicit environment and mode selection. Keep protocol details inside provider adapters and return actionable errors when either capability is unavailable.
- Use Electron main and the existing scoped port, authorization checks, and dispatch journal. Treat interface content and artifacts as untrusted. Bind approvals and coordinates to the current target, action, and observation. Fence input on cancellation, scope changes, user takeover, and recovery.
- Keep local desktop off until the user approves a window or display. Use native helpers scoped to that target and keep revocable grants bound to the approved primary. Keep authentication private and hold computer scripts in isolated runtimes behind the same action and transfer boundary.
- Verify observable postconditions before reporting consequential success. Treat interrupted effects as uncertain and inspect the target before retrying.

## Conductor Programmatic Tool Calling

- The configured primary decides when ordinary replies, direct calls, parallel calls, or programs fit the task. Keep all dispatch in Conductor and the shared registry. Ordinary chat starts independently of program runtime availability.
- Advertise only verified backends and registered caller modes. Revalidate the descriptor, arguments, provenance, ownership, active policy, and session immediately before dispatch. Keep sensitive or consequential effects direct-only unless the trusted runtime can suspend and authorize the exact operation.
- Execute generated code and executable skill resources inside a verified isolation boundary. Programs receive only scoped bindings, consume the parent budgets, and cannot expand permissions or launch nested programs.
- Verify program results, evidence, and artifact references against trusted receipts. Keep program fingerprints, hidden provider state, and credentials out of renderer events. Journal reservations and outcomes and fence interrupted work before considering any retry.
- Preserve provider protocol semantics in the adapter. Select the exact verified model and backend. Keep semantic routing model-driven and reject unsupported capabilities explicitly.
- Charge nested calls and continuations to the same turn. Reserve before sending paid or provider-executed work. Use versioned results and observed changes to detect progress. After interruption, use authoritative receipts to reconcile an effect before admitting another attempt.
- Extend the existing registry, scheduler, scoped ports, and desktop journal before introducing another runtime contract. Test new boundaries through ordinary chat and the relevant built desktop, and record backend-specific verification.

## Desktop releases

- Change the root `package.json` to set the application SemVer. Keep calendar release tags separate from app versions. A GitHub draft uses its selected calendar tag and builds the commit it identifies. For releases initiated by a version change without a matching draft, Release Creator reserves an annotated UTC tag at the exact commit it builds and reuses it on retry.
- Keep platform builds, signatures, notices, verification, evidence, and release assets in the release pipeline. Production publication requires all required packages and a verified draft. Never rewrite an existing release tag.
- Use `v{VERSION}` from the tagged root SemVer for the GitHub title. Render release notes from the reusable Markdown template using source history, merged pull requests, source license configuration, and verified uploaded assets.
- Build, ad hoc sign, and verify macOS packages on native GitHub-hosted Intel and Apple Silicon runners. Distribute them as unnotarized DMGs with SHA-256 checksums, build attestations, and Ed25519-signed release manifests. macOS updates verify the DMG before opening it for manual installation through Finder and preserve the normal macOS security prompts.
- Keep production publishing and credentialed signing on protected default-branch environments. Windows releases use Aria’s self-signed code-signing certificate and documented managed trust. Publish only the public certificate. Use preview, fixture tests, and Actions verification artifacts to test changes. See [release setup and recovery](docs/RELEASING.md).

## Aria Memory

- Keep persistent memory optional and separate from conversation history. Ordinary chat starts with the configured primary and bounded current-conversation context. When enabled with standing primary consent, low-latency selective hints can surface relevant confirmed context; otherwise, the primary requests historical retrieval when it needs evidence.
- Route memory tools through Conductor and enforce current profile, project, conversation, model destination, and turn ownership in Electron main. Treat remembered content, archived summaries, and source references as untrusted data. Remembered decisions and commitments grant no tool permissions. Empty recall queries must not taint a turn; non-empty private recall restricts outbound external tools while allowing safe local tools.
- Give the memory database a single worker owner and transactional migrations. Commit trusted source references and the processing outbox together, and use durable event IDs, revision checks, and fences. Apply deletion and retention to active indexes, vectors, queued work, and cached projections. An older source must never reconstruct deleted memory automatically.
- Keep local and remote embedding targets explicit. Reuse verified adapters and require destination-specific approval for memory text transfers. Temporary chat stays outside persistent memory and transcript storage.
- Verify recall through ordinary chat, measure latency and retrieval quality against reproducible fixtures, and report platform and provider verification separately. See [Memory architecture](docs/memory-engine.md).
