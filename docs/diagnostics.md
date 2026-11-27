# Diagnostics

The managed desktop keeps structured JSON Lines events in `logs` under Electron's user-data directory. Electron main owns persistence and applies level filters, a bounded queue, rotation and retention. On POSIX, the directory and files are created with owner-only permissions. The Windows directory inherits the profile's access controls; native Windows ACL behavior still needs packaged verification.

The shared event contract supports request, conversation, execution, generation, parent and operation identifiers. The managed chat service checks child events against its active request before accepting them. Model calls and Conductor tool activity use that scope. The live viewer and diagnostic export receive validated events, never raw stream data. Tool activity is recorded independently of its renderer presentation. Temporary-chat events remain in a bounded in-memory buffer and are discarded on conversation removal or shutdown; exports exclude them.

Conductor web and browser events include the operation phase and structured failure code when available. A browser failure can be traced to its preceding phases using the operation ID.

Only fixed structural metadata is accepted. Exception messages and paths are not persisted: error frames retain line and column only, and cause chains retain approved error codes. No raw prompts, model responses, tool arguments, shell output, file content, screenshots, credentials, or hidden reasoning are recorded. Exports pseudonymize context identifiers. Users must still review any diagnostic bundle before sharing it.

Settings control filtering and retention. Debug and trace are off by default. The legacy `info`, `warn` or `error` preference initializes the diagnostic level when no diagnostic configuration exists. Queue overflow and persistence errors are reported in Settings; logging failures do not abort the work being observed.

Current coverage includes managed chat lifecycle, model request timing and usage, Conductor tool activity and loop observations, memory worker lifecycle, IPC failures, main startup and renderer failures. Further instrumentation is needed for standalone API logging, full individual component lifecycles and recovery/retry details. Native crash dumps, worker-to-main correlation, and Windows and Linux packaged behavior are not yet verified. The viewer can sort the currently loaded events as a chronological execution timeline; a grouped multi-execution timeline remains future work.

For a repeatable synthetic throughput check, build the desktop and run `node apps/desktop/scripts/benchmark-diagnostics.cjs`. A local Darwin arm64 run processed 20,000 events in approximately 137 ms with no drops and measured a 13 ms maximum event-loop delay. This measures the logger and local sink, not end-to-end chat latency or a production workload.

Persona records bounded preference and recall counts, presentation validation and interruption status, render timings, and action outcomes through the shared sink. Chat identity follows the existing generation boundary. Temporary-chat events use memory-only storage. Presentation content, form values, and memory text are excluded. See [Aria Persona](persona.md).
