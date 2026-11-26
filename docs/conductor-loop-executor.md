# Conductor Loop Executor

Aria's configured primary decides whether to answer, discover capabilities, use tools, delegate, ask a question, change approach, or finish. `Conductor.run` uses `ConductorLoopExecutor` for both direct replies and multi-step work. Ordinary chat can answer in one provider request, without opening a project or a recovery checkpoint. Standalone API and Live Voice use the same model loop and their existing cancellation contracts. The execution controls below apply to managed desktop text chat.

## Execution lifecycle

| Control | Behavior |
| --- | --- |
| Pause | Stops admitting new work at the execution boundary. Already-dispatched work can settle and pending desktop prompts are withdrawn. Chat shows **Pausing** while the executor drains. |
| Resume | Continues a paused session under its remaining limits and current permissions. |
| Steer | Adds a user instruction to the same execution. The executor discards decisions that have not entered dispatch and gives the primary the new instruction at the next safe boundary. |
| Answer | Supplies the requested clarification to the waiting execution. |
| Stop | Cancels the request, fences further dispatch, and disables recovery for that execution. Verified output and uncertain operation history remain visible. |
| Resume execution | Claims a new generation for a saved interrupted execution. Aria opens and verifies the checkpoint before carrying on. |

Pending, active, waiting, and terminal states are projected over the existing chat event stream. Events are scoped by request, conversation, assistant message, execution ID, generation, and sequence. The renderer renders snapshots from Electron main and drops events from earlier generations. The stream bounds its pending frames and merges adjacent text deltas while waiting for its consumer. Permissions, evidence, and published artifacts have independent records.

## Tool decisions and permissions

Discovery progressively loads the shared registry's schemas. A primary can send ordinary parallel tool calls or the `aria_execute_batch` control with `{id, tool, args, after}` operations. `tool` names the exact loaded direct tool. `after` orders entries within the batch. Existing `dependsOn` arguments bind earlier execution results. If a tool needs data from an earlier operation, the primary can wait for its result and issue a new call with the actual arguments. The engine rejects an invalid dependency graph before dispatch, blocks branches whose prerequisites failed, and returns observations in request order. Program containers, memory, and computer calls use their existing direct or program contracts. Image-producing operations use their existing response transport.

Web search discovers candidates. HTTP fetch retrieves static evidence and response metadata. The browser inspects rendered pages and handles interactions. The primary can choose each operation independently. A destination supplied by the user can be opened directly, including an HTTPS-normalized bare domain. A discovered source carries a runtime `sourceId` and `producerStepId`. The caller copies the source ID and includes the producer in `dependsOn` for a later authorized call. Browser tab and document handles likewise require completed producer steps. A resumed generation obtains fresh handles.

The registry declares which reads and delegates can run concurrently. The shared scheduler limits capacity and serializes work on the same resource. Private reads can restrict later outbound operations. Tool arguments, ownership, available capabilities, authorization, and generation are checked when admitting and dispatching work.

Desktop approval stays bound to the exact action. Direct keyword and phrase searches can grant **Allow for this execution** for the named primary and exact selected document versions. The grant is scoped to the active request generation and is discarded on steering, release, or a policy change. New versions, remote embeddings, executable scripts, and consequential operations follow their own approval checks. Existing persistent capability grants keep their scope and revocation controls. Remembered content, skills, and tool output cannot grant permission.

The primary can include completion status, verified step IDs, unresolved operations, and optional readiness self-assessment (`objectiveAddressed`, `claimsSupported`, `remainingUncertainty`) in `aria_reply_metadata`. Browser and desktop inputs reported as submitted need a later observation of the same target before Aria reports a verified outcome. A completed transport call, a submitted input, and a verified effect are separate states. Cross-tool read recovery allows the primary to pivot strategies after a read failure, and transparent partial/uncertain limitation summaries are preserved when no unrecovered side-effect failure occurred. Budget exhaustion after successful work returns a partial result and preserves the activity and evidence already collected.

## Recovery and data retention

Managed calls that start tool work or wait for the user can write encrypted checkpoints in `runtime.sqlite`. The version 8 migration adds the checkpoint table. The initial saved chat turn remains the source of the objective. Checkpoints store the budget and reservations, user steering, any open question, and bounded operation receipts and privacy flags. They exclude raw recalled memory, images, credentials, and provider continuation state. Temporary chat and profiles without OS-backed encryption have live controls. Snapshots expire after 24 hours and the profile can hold up to 16. Conversation deletion removes associated checkpoints. Dispatch fences and verified artifacts keep their separate retention rules.

On explicit resume Electron main checks the saved turn and the original primary, endpoint, and credential. It claims the next generation and reconciles existing dispatch and tool receipts. Conductor rebuilds bounded context from that turn and the checkpoint. The model can request current evidence through authorized tools. Receipts with uncertain outcomes fence the affected capability. An interrupted provider-hosted operation requires review. Aria can still retrieve an already-verified final Stored Response through its separate recovery control. Browser and computer sessions require fresh valid observations and authorization. Changing the primary, expired checkpoints, and storage or budget failures produce an actionable message.

Memory recall remains model-driven. Recalled excerpts stay outside the recovery snapshot. Subsequent retrieval checks current memory scope, privacy policy, and deletion fences. Existing outbox rules govern durable memory proposals from completed replies.

## Limits and verification

**Settings → Tools → Execution limits** controls model requests, tool attempts, token ceilings, active time, concurrency, operation timeout ceilings, verified-read retries, and stagnation. Defaults are 12 model requests, 20 tool attempts, five active minutes, three simultaneous operations, up to two eligible read retries, and a cutoff after three stagnant rounds. **Web & Browser** has independent search, HTTP fetch, navigation, inspection, and screenshot allowances. The primary sees remaining limits on continuation. Invalid inputs consume a general attempt. Outbound work consumes its operation allowance once dispatch begins. Repeating a failed research operation requires the prior attempt ID and an eligible retry condition. The existing verified spending cap applies to primary, delegated, and nested work, including reservations carried into an explicit resume. Waits for pause or clarification suspend the active clock and expire within the session's idle window.

Built browser fixtures run with the normal Electron suite. `ARIA_RUN_PUBLIC_BROWSER_SMOKE=1` enables the public-site smoke test with a fixture model. `ARIA_RUN_PUBLIC_RESEARCH_EVAL=1` enables the live desktop research evaluation with an explicitly configured `OPENAI_MODEL` and `OPENAI_API_KEY`. Run the live evaluation separately from CI and review the recorded activity and sources.

For example, set **Maximum model requests** to `8` and **Maximum active time** to `120` seconds to bound short research tasks. Save runtime settings to apply the limits to new work. An explicit resume applies the stricter of the saved and current values.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm licenses:check`, and the built Electron suite on macOS and Windows. `node tests/conductor-benchmark.mts` measures direct chat, discovery, and independent tool calls against a local provider fixture. Live providers, OS permissions, optional isolated backends, and packaged builds each need their own validation. Mana-Agent has no registered connector in this checkout. Exact configured model delegation uses the shared registry.


Managed proactive jobs use the same executor, scheduler, registry, and receipt fencing with a job-owned scope and durable lease. Their starting message is a system event. See [Proactive Assistant Runtime](proactive-assistant-runtime.md).

Aria Connect registers deferred GitHub tools over the same capability host. Electron main checks the selected connection, provider permissions, approved repository, primary identity, and active scope at dispatch. See [Aria Connect](aria-connect.md).
