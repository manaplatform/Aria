# Web and browser security

The application renderer owns the visible browser controls. Remote pages have no Aria preload, Node integration, or trusted IPC. They are sandboxed in separate sessions. Personal sessions are in memory unless persistent site data is enabled. AI tabs have independent memory-only sessions and a conversation owner. The user can share personal content only by copying it into the chat draft. Native action prompts show the target and values and expire on a timeout or cancellation.

The browser’s local egress proxy validates resolved IPs and connects to a validated address. Web search and page reads use isolated Chromium views. The backend receives bounded browser results over the existing utility-process port. The browser uses a fixed proxy with no direct fallback, including for loopback candidates. TLS verification is left intact. Browser permission, popup, download, and scheme rules apply separately. Chromium QUIC is disabled and remote views disallow non-proxied WebRTC UDP. Browser and page network policies do not alter the application's loopback API or configured model transports.

AI DOM inspection runs fixed code in an isolated world. Node references are scoped to an inspected document and active turn. The model never supplies code or selectors. Approval is per action. Ordinary same-origin HTTPS POST forms can be submitted if Chromium's request matches the approved target and encoded fields. AI requests otherwise use GET or HEAD. Websites can still attach effects to a GET, and Aria reports uncertain outcomes when it cannot verify them. Sensitive or unsupported actions stay with the user in a Personal tab.

Conductor exposes only tools enabled for the run. Browser search uses the Brave website and sends no search API credentials. Search discoveries are transient. Publisher reads provide provenance used for persistent citations. Saved web policy, browser history, and session state live outside model configuration and conversation history. Approval payloads and AI page bodies are transient. Explicit screenshots use the existing artifact store and conversation retention.

Automated fixtures should cover network denial, managed browser requests, source history, cancellation, and process isolation on the built macOS and Windows desktop. Local fixtures are evidence for those test cases. Public-site smoke tests, live provider acceptance, and third-party redistribution review are separate release checks. Validate the latest available security patch for the Electron series before shipping a build.

## Tool authorization and retry

The tool registry evaluates policy at discovery, definition load, and dispatch. Electron main hosts skill imports, native browser approvals, and the durable dispatch journal. The managed service gets a scoped port for approved resource reads and dispatch reservations. Each request is matched to the current service generation, policy revision, and active text turn or Live Voice session.

Before an approved consequential action or billable model operation runs, the runtime records its reservation under the saved logical turn. A retry with the same logical turn cannot dispatch external actions after a previous attempt may have dispatched one. A fresh user turn can authorize a new action. A timeout after dispatch may leave the remote result uncertain. The journal stores hashes and attempt ownership, without tool inputs or approval values.

Desktop dispatch reservations use the execution database. Legacy file reservations remain readable and are imported transactionally on first access. Native prompts are serialized, with cancellation tied to their operation signal. Each driver rechecks the approved target, arguments, and session immediately before dispatch. Managed history is rebuilt from saved records before the model sees it, and private history restricts both browser and program dispatch.

Verify with the built macOS and Windows Electron suites, the API's native wire fixtures, and a live configured Responses smoke test where credentials are available. Test malformed archives, private-resource transfer restrictions, revocation, cancellation, and recovery after a reservation.

## Execution capability boundary

The private capability port validates active turn bindings and the configured primary before runtime operations. Docker workspaces access staged files through the main-process broker, with kernel resource controls and an offline network namespace. Document parsers and the optional local embedding runtime use isolated Chromium sessions. Evidence and artifact access use versioned application IDs. File and network transfers require a reviewed, destination-specific grant. See [execution and knowledge](execution-knowledge-runtime.md).

Computer Use shares the port and journal. Coordinate input uses an isolated browser tab with network activity suspended. Private sign-in runs in a separate single-origin partition while the user controls it. Authentication data stays in that partition and the model receives only bounded structural metadata after control returns. The public upload and download broker validates the observed destination again after approval and connects to a validated public address with redirects disabled. See [Computer Use](computer-use.md).
