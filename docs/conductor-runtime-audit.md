# Conductor runtime stabilization

The original stabilization findings below describe the earlier runtime. The current lifecycle, tool batch contract, limits, and restart behavior are in [Conductor Loop Executor](conductor-loop-executor.md).

The stabilization baseline is `142967a`. It contains the four prior phase branches, from Tool Intelligence through Programmatic Tool Calling. The stabilizing changes reuse the primary-model loop, the tool registry and scheduler, the scoped desktop ports, and the existing execution drivers.

## Runtime boundaries

- Electron main reconstructs outgoing history from saved chat turns. Private context stays scoped to the current provider revision and restricts direct and programmatic outbound operations. The execution engine rechecks authorization after waiting for capacity and again before dispatch.
- One turn ledger counts model and continuation requests, control and execution steps, native result reservations, and token usage. Context sizing uses a conservative estimate before requests and provider totals when returned. Availability, dependency checks, and progress detection use runtime state. The primary can revise its approach after a structured no-progress diagnostic.
- SQLite v5 adds dispatch ownership and receipts, with lazy import of existing file reservations. v6 adds encrypted provider checkpoints and approval decisions. Open approvals expire on restart. Guarded operations keep their logical-turn fence. Browser, workspace, and program session tables retain their specialized state.
- Stored Responses recovery retrieves a final response after an explicit request, with the same provider identity and owner. A checkpoint for outstanding work surfaces an interruption and requires review. Stateless provider replay stays in memory. Hosted resource cleanup uses the owning credential and can run after the chat turn ends.
- Sources and document evidence persist separately from the bounded activity display. Published files have verified ownership, size and integrity. Restart reconciles available files into the originating saved message before orphan cleanup.
- The opt-in spending cap accepts scoped model text rates supplied in authenticated, unit-validated catalog metadata. Unpriced model and backend operations are blocked when a cap is active. Existing workspace CPU, memory, storage, and process isolation and network policies remain backend controls.

## Capability verification

| Capability | Registry and backend | Authorization, cancellation and recovery | Evidence, artifacts and UI | Verification |
| --- | --- | --- | --- | --- |
| Tool Search | Progressive Aria controls and an explicit Responses client-search adapter. Exact unavailable IDs return actionable errors. | Policy applies to discovery, loading, and dispatch. Cached metadata is turn scoped. | Streams discovery and load status. | Aria fixtures passed. Native protocol fixtures passed. Live native proof remains environment specific. |
| Skills | Approved versioned bundles, scoped resource reads, offline reviewed scripts, optional hosted bindings. | Version/digest checks, trusted prompts, and Shell reservations. | Scoped resource references and skill activity. Scripts can publish files. | Built macOS local bundle and real Docker PDF passed. Hosted skills require live verification. |
| Shell | Managed offline Docker workspace and explicit Responses adapters. | Scoped workspaces, command time limits, transfer approval, and attempt fencing. | Bounded command output and verified artifacts. | Real Docker Shell, PDF, and workbook workflows passed on macOS. Native Shell has protocol tests. Live hosted behavior remains open. |
| File Search | Local keyword/phrase and optional verified embedding or OpenAI vector-store paths. | Owned files and collections, transfer checks, abortable retrieval, resource cleanup. | Versioned document evidence and citation inspection. | Built macOS keyword retrieval passed. Embedding pack and live OpenAI indexing remain open. |
| Computer Use | Managed browser, scoped local display, optional virtual desktop and Responses transport. | Foreground lease, fresh observation, approved inputs, takeover and stop. | Session controls and outcome status. | Built managed browser and fixture-based local selection/revocation passed on macOS. Physical OS permissions, Windows and the virtual image require separate verification. |
| Programs | Shared broker for offline QuickJS and OpenAI Responses. | Loaded bindings and caller scope are checked. Child reservations are fenced. | Nested activity and validated evidence and artifacts. | Managed broker, guest runner and Responses wire tests passed. Docker runner image build hit Docker Desktop storage capacity. Live hosted execution is unverified. |
| Web Search | Brave search through the isolated browser. | Public-network validation and cancelable scoped IPC. | Search discoveries can lead to cited publisher reads. | Built fixtures and a live public Brave smoke test passed. The primary model was a local fixture for both tests. |
| Internal browser | Isolated AI tabs and separate user-controlled browsing. | Exact-value approval, egress checks and durable reservations. | Structured observations, source links, screenshots and activity. | Built fixtures cover private-network denial and navigation. A live publisher read from example.com passed. |
| Image generation | Explicit delegated media model via the existing provider adapter. | Exact target, transfer policy and durable billing reservation. | Validated image previews and persisted files. | Generation, editing, cancellation and restoration passed with provider fixtures. Paid provider verification remains open. |
| Mana-Agent | Connector extension point available. | No operational registry entry. | Unavailable. | Outside this refactor. |

## Performance

Run `pnpm --filter @aria/api build` and `node tests/conductor-benchmark.mts` from the root. The measurements below used a local loopback fixture on macOS arm64 with 20 warm observations per workload and three warmups. Startup is Nest startup. CPU and RSS include the fixture process. Electron startup, live-provider latency, and paid usage require separate measurements.

| Measurement | Baseline | Stabilized |
| --- | ---: | ---: |
| Ordinary chat median / p95 | 58.18 / 63.10 ms | 59.03 / 61.87 ms |
| Ordinary chat median to first token | 12.11 ms | 11.64 ms |
| Ordinary chat provider requests / wire bytes | 1 / 4,392 | 1 / 4,032 |
| Discovery median / p95 | 128.31 / 136.70 ms | 135.02 / 142.20 ms |
| Discovery median to first activity | 12.49 ms | 11.74 ms |
| Discovery provider requests / wire bytes | 2 / 9,729 | 2 / 9,009 |
| Nest startup, one observation | 371.83 ms | 252.12 ms |
| Fixture/API CPU across the warm runs | 1,179 ms | 1,136 ms |
| Fixture/API RSS at the end | 230.6 MB | 233.8 MB |

Discovery total latency rose in this run while wire size decreased. The harness reports startup and workload timing separately so the comparison can be repeated without conflating a single startup observation with typical latency.

## Release gates

Typecheck, lint, build, and the license check passed. The workspace suites passed 153 tests with the Docker endpoint configured. The live model evaluation was skipped. The isolated QuickJS guest passed three tests.

The built macOS suite passed 26 scenarios, including the public publisher and Brave checks, managed browser isolation, the display selection and revocation fixture, and three Docker-backed artifact workflows. The three skipped built scenarios require the offline program image, the embedding pack, and the virtual desktop image. The inspected Docker Desktop instance returned `ENOSPC` while building the program image.

Run typecheck, lint, unit and integration tests, the guest suite, the built Electron suite, and the license check. CI defines the macOS/Windows checks and opt-in isolation jobs. Live providers, real graphical drivers, and semantic retrieval use their individual configuration and tests. Full combined acceptance with an isolated program, a website and attachments, cross-platform release acceptance, and comparable startup and resource benchmarks for every optional runtime still require those environments.

Use `ARIA_RUN_PUBLIC_BROWSER_SMOKE=1 pnpm --filter @aria/desktop test:electron --grep 'reads a public publisher'` to repeat the public check. The test uses a temporary desktop profile, a loopback model fixture, and public read-only requests.
