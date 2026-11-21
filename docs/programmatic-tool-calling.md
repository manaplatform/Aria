# Programmatic tool calling in Aria

Conductor can coordinate a bounded group of tools within an ordinary desktop chat. The configured primary decides whether to answer directly, issue individual or parallel calls, or compose a program. Settings → Tools → Programmatic tool calling defaults to **Off**.

## Backends

**Aria isolated JavaScript.** Configure the local Docker engine in Tools and build the reviewed runner image. Supply the immutable image ID to the settings probe.

```sh
docker build -t aria-program-runner apps/desktop/program-runner
docker image inspect aria-program-runner --format '{{.Id}}'
```

The probe runs a synthetic async call inside QuickJS WebAssembly and checks that host APIs are absent. Each execution gets a fresh non-root, offline container with a read-only root, seccomp, dropped capabilities, and CPU, memory, and process limits. The Docker socket stays in Electron main. The guest sees JSON and scoped tool bindings. Only the broker can dispatch tools.

**OpenAI Responses.** Select an official OpenAI primary and verify the chosen Discovery and continuation combination. Verification runs a synthetic JavaScript program, checks a client-owned child call and its caller metadata, and waits for the final response. A change to the primary, credential, discovery mode, or continuation invalidates the proof. Stateless mode sends ordered continuation items with `store: false`. Stored mode opts into OpenAI response storage and uses `previous_response_id`. OpenAI project data controls govern actual retention. [Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling) · [Data controls](https://developers.openai.com/api/docs/guides/your-data)

## Dispatch and recovery

Loaded descriptors define caller modes and program eligibility. Conductor checks each child against the active scope and the original schemas. The existing execution engine checks dependencies and resource locks and emits the activity. Desktop runtime children require a durable reservation tied to the provider, conversation, turn, policy revision, and operation.

Managed programs can pause at the tool dispatch boundary and resume from chat activity while the turn is active. Child calls already dispatched can settle. Stop cancels the chat and fences new dispatch. Programs preserve verified evidence and artifacts and return a structured complete, partial, failed, cancelled, or uncertain result.

SQLite schema version 4 adds program and child metadata and encrypted, conversation-scoped program results. Conversations and existing execution and document records are preserved. Completed or partial results can be inspected from activity for up to 24 hours when OS encryption is available. Interrupted reservations become uncertain and are fenced from silent replay. OpenAI response IDs, opaque fingerprints, raw replay state, and JavaScript source are kept out of activity and logs. Live continuation works inside the active turn. Crash-time replay tokens remain in memory, so an interrupted hosted program cannot be reattached from history.

## Six-tool audit

| Capability | Registry and runtime | Permission, activity and lifecycle | Verification scope |
| --- | --- | --- | --- |
| Skills | Built-in and installed bundles load progressively. A loaded skill can provide a `scripts/*.js` or `scripts/*.mjs` program body. Managed programs can invoke eligible reviewed workspace scripts through the existing skill descriptor. | Version and digest checks, exact workspace script approval, and Shell attempt journal. | Built app exercises installed skill loading and PDF generation. |
| Shell | Managed workspace commands and OpenAI Shell remain direct. Reviewed skill scripts and artifact publication can run through managed program bindings. | Owned workspace, offline execution, transfer approvals, per-workspace locks, durable attempts. | Real Docker workspace and built-app artifact fixtures. Hosted support requires its own live proof. |
| Computer Use | Managed programs can inspect availability and request structured observations on an already-open authorized session. Browser, virtual, local and OpenAI visual actions are direct. | Foreground lease, session lock, current observation and exact action approvals. | Managed-browser Computer Use and takeover exercised in macOS Electron. Drivers and native providers require their independent tests. |
| File Search | Managed programs can retrieve authorized keyword and phrase evidence. Provider File Search stays direct. | Existing file, collection and destination approval with versioned citations. | Built-app local citations. Live hosted retrieval and offline embedding paths use their opt-in tests. |
| Tool Search | Aria discovery and OpenAI client Tool Search feed the same registry. The model loads deferred function definitions before a program can use them. | Current descriptors are checked at discovery, loading and invocation. | Aria normal-entry tests and Responses wire fixtures. The native combination requires the Settings probe. |
| Programmatic Tool Calling | Aria isolated JavaScript and OpenAI Responses share the broker. Public structured web reads are eligible; authenticated browser state, form actions and external writes stay direct. | Bounded guest, scoped bindings, centralized approvals, nested activity, and durable dispatch metadata. | SDK-wire fixtures, guest tests, and real runner-image verification when configured. |

The repository has a coding connector extension point. The current registry has no operational Mana-Agent connector.

## Verification

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm licenses:check`, and the built Electron suites on macOS and Windows. Run `npm ci --ignore-scripts` and `node --experimental-strip-types --test runner.test.mts` in the program runner directory for the isolated guest test suite. The OpenAI fixture tests validate call and fingerprint round-tripping, both continuation policies, and output-only continuation. The Settings probes verify actual environment and provider access.

A local synthetic benchmark performed three deterministic lookups, aggregated their results, and verified the same total on each run. After three warmups, 20 samples yielded median/p95 latency of 15.01/15.11 ms for sequential reads, 5.18/5.27 ms for parallel reads, and 80.16/83.45 ms for a fresh QuickJS guest process running parallel reads. These timings include guest process startup and exclude Docker and model requests. Live latency, tokens, and cost require provider verification.

Local verification passed 136 unit and integration tests, three QuickJS guest tests, and 23 built macOS Electron tests. The built suite exercised Docker Shell and artifact generation, local document citations, and managed browser Computer Use. The optional program image build hit Docker Desktop's storage limit. The isolated program test in built Electron, live OpenAI program access, Windows, and the opt-in graphical and semantic runtimes remain open for release verification. Runtime telemetry records observed provider requests, continuations, tokens, and child activity. A provider pricing source and monetary quotas remain outside the current implementation.
