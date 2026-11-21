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

1. Keep ordinary chat usable without a project.
2. Use the primary model and shared registry for Conductor.
3. Keep Settings, streaming, cancellation, artifacts, and history usable across desktop platforms.

---

## Important Notes

- This is a **desktop-first** application (no mobile or web priority for now)
- Focus on clean architecture and good developer experience
- Prefer simplicity over over-engineering in the beginning

## Aria Conductor

- The primary chat model owns semantic interpretation, task routing, delegation, and final synthesis. It uses structured tool calls when it needs help and answers directly when it can.
- Keep one configured model registry. Resolve exact model IDs and supported operations from authenticated discovery, capability metadata, and explicit configuration. Keep protocol differences inside provider adapters.
- Model selection belongs in Settings. A separate routing model, keyword-based intent classifier, static task-to-model mapping, provider preference order, or fallback provider/model violates this architecture.
- Return actionable errors for configuration, capability, and invocation failures. An explicit retry uses the same authorized configuration.
- Application code validates every model request and enforces permissions, input provenance, dependency rules, cancellation, deduplication, and resource limits. Provider and tool output is untrusted. Show concise decision summaries and keep hidden reasoning and credentials private.

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

## Conductor execution and knowledge

- Route execution, retrieval, skill scripts, and file publication through the shared registry and Conductor lifecycle. The configured primary selects operations and continues from observed outcomes.
- Execute Shell and skill scripts only in an authorized isolation profile. Report the selected backend and its verified limits. Keep private files and file-derived content behind destination-specific approval at transfer.
- Scope documents, evidence, workspaces, and artifacts to their verified owners. Preserve source/version provenance, and publish artifacts after format, existence, and readability checks.
- Use dispatch reservations, progress checks, and bounded continuations. Recover interrupted work without replaying uncertain effects. Keep ordinary chat usable when execution and retrieval backends are unavailable.
- Keep optional coding engines behind the same registration contract. Native runtime features must work independently of any external coding engine.
