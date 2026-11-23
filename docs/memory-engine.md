# Aria Memory

Memory starts disabled. **Settings → Memory** enables it, controls retention and suggestions, and lists saved records. **Save to Memory** on a saved user message promotes a selected source to an episode after review. Users can inspect, correct, forget, clear, and export records independently of their chat history. Persistent memory and temporary conversation history have separate lifetimes.

## Data flow

Electron main reads the saved latest user message and projects a bounded working snapshot. Short chats use their normal turn history. Longer chats can include earlier source-labelled excerpts when the model budget has space. The API carries those excerpts as untrusted conversation content. No memory query runs as a prerequisite to the primary response.

The configured primary can discover and call the `memory` namespace through the ordinary Tool Registry. Searches can use phrases, terms, entities and aliases, relationship expansion, metadata filters, time ranges, and optional vectors. Results carry stable IDs and provenance. A grounded `aria-memory:` link uses IDs acknowledged by the desktop and validates the reader's scope again. Evidence results are private and restrict outbound tools while present in the turn. Model-generated content cannot authorize an action.

The primary can attach optional structured metadata to a complete visible reply. Metadata proposals use exact spans from the newest saved user message. They are staged in a trusted outbox with their source in the same atomic chat save. Metadata cannot acknowledge an explicit mutation. Explicit remember, correct, and forget tools show a trusted confirmation and wait for the SQLite transaction. Suggestions use the same metadata channel and go through normal chat submission when clicked.

## Storage and migration

Each desktop profile owns `memory.sqlite`. A worker thread owns its SQLite connection and prepared statements. The versioned schema stores authoritative records, sources, entities, aliases, links, FTS5 postings, vectors, jobs, execution receipts, and deletion fences. Conversation, project, and portable profile preferences have distinct scopes. A project is selected before the first message. Equal entity names can have distinct qualifiers. Conductor does not assign project ownership from a text reference.

Existing `aria-v3.json` profiles retain their history. The chat schema migration adds optional project and suggestion fields, citation references, and a main-owned outbox. It performs no startup transcript backfill. The local memory database opens separately from runtime execution journals and ordinary chat continues when it is unavailable. A newer memory schema is preserved on disk if an older app cannot open it.

A worker batch processes a bounded set of queued events on its single connection. Model proposals come from completed primary replies, and older chat messages can be explicitly saved from their source. The worker performs validation and consolidation without a separate model call. Record changes and their completed receipts commit together. A worker interruption rolls back the transaction, preserving the event for replay. The outbox admits each stable event once, with bounded retries and explicit failed-job counts. Exact duplicate records merge their provenance. An explicit correction creates a new version and supersedes the previous version. An unconfirmed observation can coexist as a conflict. Timeline searches include prior versions; ordinary recall prefers current confirmed information. Pending tasks keep status, dependencies, and references. Scheduling and execution require separate authorization.

Expiry and deletion remove active postings, vector references, and related aliases, invalidate caches, and advance a durable processing fence. The fence rejects late work and old queued entries. Sources that backed a deleted record cannot regenerate it automatically. Review of a retained conversation can still reveal text from that conversation, including an old assistant reply that quoted a remembered fact.

## Embeddings and transfers

Lexical search works without embeddings. Local semantic search reuses the verified pack installed under **Settings → Tools**. Remote processing uses a configured HTTPS connection and exact embedding model. Saving a remote target verifies it with synthetic input. Each remote semantic search asks for a destination-specific approval before sending the query and its bounded batch of eligible snippets. Changing model identity or vector dimensions separates vector spaces. A destination with unavailable embeddings or unverified turn pricing exposes an error. Users can choose lexical search explicitly.

Recalling persistent content sends snippets to the exact configured primary once the desktop authorizes that reply. Embedding approval is independent of this transfer. Temporary conversations have session-only transcripts, no persistent memory recall or extraction, and no Live Voice. Ordinary provider processing still applies to a submitted temporary message.

Indexed memory text is readable to someone with filesystem access to the profile. Aria keeps credentials in its OS-backed provider store and rejects recognized authentication secrets before memory indexing. SQLite WAL pages, external exports, backups, filesystem snapshots, retained chat, and data already transmitted to a provider have independent erasure limits. Memory deletion is an application-level removal and processing fence.

## Verification and performance

Run the repository checks and these focused scenarios.

```sh
pnpm --filter @aria/desktop exec vitest run tests/memory.test.ts
pnpm --filter @aria/desktop build
pnpm --filter @aria/desktop test:electron --grep 'recalls memory across|keeps temporary chat out'
pnpm --filter @aria/desktop exec node scripts/benchmark-memory.cjs
```

The Electron cases exercise the built renderer, managed API, test provider, real worker and SQLite store, native approval boundary, and restart. The relevance fixtures cover lexical ordering, alias ambiguity, scoped relationship expansion, historical versions, and irrelevant queries. The baseline context selector only has prior pairs from the current conversation. The managed test observes recall in a fresh chat and confirms that the retained original transcript does not recreate the deleted record. The fixture scripts model behavior and cannot measure live-model follow-up accuracy.

The full macOS ARM64 build suite passed 26 Electron cases with nine optional cases skipped. Five focused packaged cases passed for cross-chat recall and deletion, temporary chat isolation, settings restart, native mutation approval, and remote embedding transfer approval. The packaged provider fixtures used a synthetic credential cipher so they could run without interactive Keychain prompts. The regular built suite also exercised real OS-backed provider storage.

For a packaged smoke, run `pnpm release:package dir /path/to/local-output` and set `ARIA_TEST_PACKAGED_APP` to the executable. Set `ARIA_PACKAGED_PROVIDER_FIXTURE=1` for the synthetic provider cases. The macOS verification package uses local ad hoc signing.

Windows and Linux packaging, live provider follow-up quality, and real local embedding-pack retrieval remain open. Current automatic extraction uses same-reply primary proposals and background SQLite processing. Independent batch inference and whole-archive import are outside this implementation.

### Reference benchmark

Apple M4 Pro, arm64, 24 GiB RAM, Node 26.5.0, generated records, and 384-dimensional synthetic vectors. Times are p95 milliseconds measured inside the worker store. Cold samples reopen the SQLite connection with the OS page cache intact. The benchmark excludes IPC, model inference, and embedding generation.

| Records | Cached | Cold rare phrase | Warm rare phrase | Warm common terms | Cold exact hybrid | Warm exact hybrid |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.010 | 0.603 | 0.186 | 1.792 | 7.059 | 3.451 |
| 10,000 | 0.007 | 0.412 | 0.143 | 1.626 | 103.919 | 41.484 |
| 100,000 | 0.007 | 0.587 | 0.158 | 15.671 | 365.946 | 392.555 |
| 1,000,000 | 0.008 | 0.459 | 0.193 | 144.533 | 14,008.874 | 10,716.121 |

At 100,000 records the cached working snapshot timed below the 0.001 ms reporting precision. Rebuilding it p95 was 0.504 ms on the measured 151-message fixture. The baseline current-chat selector p95 was 0.001 ms on the same fixture. Cache and indexed lexical results met their targets in this benchmark. Exact hybrid exceeded the 100 ms target. Removing the SQL sort of vector blobs and using typed-array dot products improved the warm result from 772.685 ms to 392.555 ms. A scope-aware shortlist or compact vector index should be evaluated against exact recall before changing the default. The million-record fixture used about 3.13 GB on disk. Interactive vector scans have a seven-second deadline and return a scope or lexical-search error if they exceed it. The standalone benchmark measures uncapped scans. Streaming latency limits still need end-to-end measurement.

## Extension points

Add managed memory actions to the shared schemas and Tool Registry, then wire them through the existing active-turn runtime bridge. Add a store migration for new authoritative data. Add embedding transports through verified registry capabilities and the desktop embedding adapters. Keep raw text, prompts, and tokens out of diagnostics. Store counters and worker timings separately from user-facing activity.
