# Aria Persona

Persona extends managed desktop text chat. The selected primary chooses tone, language, depth, and presentation from the task and conversation. The normal Conductor loop provides the preferences in its prompt. Direct replies can use one model request.

## Persona & Communication

Settings starts with Adaptive, warmth 75, detail 50, humor 30, and adaptive visuals, emoji, symbols, and learning enabled. The sliders and mode are communication preferences for the primary. Current user instructions take precedence over explicit settings, then relevant confirmed communication memories, then defaults. Existing concise and detailed settings supply detail values of 25 and 75 until the user changes or resets Persona. The preview uses local controls. Changes apply on the next submitted turn.

Persistent Memory must be enabled for learning. A completed reply may suggest the exact span of the latest user message that states a durable tone, language, detail, format, emoji, or symbol preference. Electron main checks the quote and conversation scope. The existing durable intake transfers the proposal to the memory worker. Accepted proposals become confirmed profile preferences with chat provenance. Settings provides review, dismissal, correction, and deletion. Recall keeps its existing destination consent and relevance rules. Turning off learning excludes tagged communication records from foreground recall and prevents new proposals. Temporary chats use their in-session context.

## Streaming and actions

The primary can interleave Markdown with top-level `aria-ui` blocks. Version 1 uses a bounded node registry, stable IDs, revisioned blocks, and typed data and action references. The managed API removes component source from visible prose and validates block updates before emitting them. Electron main validates stream and ownership, and saves the canonical projection through existing chat storage. Complete blocks can render before the reply finishes. Interrupted replies retain validated parts. The managed renderer still reads earlier Markdown and `aria-visual` replies.

A grounded dataset is an exact JSON array of rows, TSV, or simple CSV span from the latest user message, or a bounded projection of an eligible completed Conductor result. Illustrative data carries a visible label. Charts use those rows. Diagrams use semantic nodes and edges and render through trusted SVG primitives. Local actions include sorting, filtering, navigation within a response, checklist, calculation, and form editing. A native save dialog controls CSV and SVG exports. Exported CSV protects spreadsheet formula-leading text, and SVG output escapes all labels.

A generated request is editable in a review dialog. Sending it enters the normal chat and Conductor permission lifecycle. Links and exports resolve against the original response in Electron main. Existing native approval UI remains authoritative. Presentations carry neither executable code nor authority to operate an external tool.

## Compatibility and verification

Settings and assistant presentation data are optional in version 3 chat storage. The memory worker adds its proposal table in a transactional SQLite migration. Existing transcripts need no backfill. A previous Aria version that only supports memory schema v1 leaves the v2 database intact and reports Memory as unavailable. Standalone API and Live Voice retain their response formats. Dependencies come from Aria’s existing React, Radix, Dagre, Recharts, KaTeX, Zod, and table virtualization stack.

Use the deterministic provider fixture to exercise normal streaming, authority checks, history restore, and local views. For local latency testing run:

```sh
ARIA_BENCHMARK_PERSONA=1 pnpm --filter @aria/desktop test:electron --grep 'measures warm first-text'
```

Use the same environment flag and the `measures Persona validation` test for component timings. The first-text fixture sends three warm-up turns and measures twenty turns from Send to the first nonempty renderer delta. Report the platform, median, and p95. Live model communication quality and cross-platform behavior have separate acceptance requirements.

On macOS ARM64, the local fixture measured median and p95 first-text latency of 26.7 ms and 38.2 ms before Persona, and 14.1 ms and 15.8 ms with Persona. Each run used twenty measured warm turns and one provider request per turn. Local scheduling and cache state can affect the comparison.

The 12-row table fixture measured median validation of 0.7 ms and median time to its first populated animation frame of 5.6 ms. At the 500-row and 12-column limits, the medians were 9.1 ms and 5.9 ms. Each size used three samples. The 500-row view rendered fewer than 50 table rows in the DOM during the check.
