# Aria – Desktop AI Agent

## Project Overview

Aria is a modern desktop AI assistant built with:
- **Backend:** NestJS (TypeScript)
- **Desktop Frontend:** Electron + React + TypeScript + Tailwind CSS + shadcn/ui
- **AI Layer:** Vercel AI SDK + LangChain.js (optional)
- **Communication:** REST + WebSocket (for streaming)

The goal is to create a clean, scalable, and beautiful desktop AI bot.

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
- Never hardcode API keys — use environment variables

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
- Communicate with NestJS backend via REST + WebSocket
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

1. Set up monorepo structure (NestJS + Electron)
2. Create basic NestJS API with a simple chat endpoint
3. Create Electron + React shell with a beautiful chat UI
4. Connect frontend to backend with streaming
5. Add conversation history and basic settings

---

## Important Notes

- This is a **desktop-first** application (no mobile or web priority for now)
- Focus on clean architecture and good developer experience
- Prefer simplicity over over-engineering in the beginning
```
