# Computer Use

Conductor discovers Computer Use in ordinary desktop chat. The primary explicitly selects an environment and protocol. Use **Settings → Web & Browser** to enable the Aria AI browser. Use **Settings → Tools** to verify OpenAI Computer Use or typed image results for the configured primary. The two probes send synthetic images and verify their continuation separately.

## Environments

- **Managed browser.** Open an authorized public page with Browser and attach its AI tab to Computer Use. Visual interaction quarantines the tab’s network. Use structured Browser tools for supported online form submission, or navigate the Computer Use session to a fresh, independently validated public page. Ordinary web research and Personal tabs retain their existing policies. Public downloads require an observed direct HTTPS link. The upload broker supports observed same-origin single-file multipart forms with an explicit file and destination approval. Forms with session credentials, other fields, or unsupported behavior remain user-controlled.
- **Private browser sign-in.** Private sign-in opens a new ephemeral session for one HTTPS origin. During takeover the user operates the view directly and the model receives no screenshots or page observations. Returning control suspends network activity and permits only structural metadata with opaque control references. Authenticated screenshots, automated authenticated input, and private downloads stay user-controlled. Sites that require a separate identity-provider origin need a Personal tab and user-reviewed sharing.
- **Virtual desktop.** Build the reviewed image locally, copy its immutable image ID into **Virtual desktop image ID**, and verify against the configured Docker endpoint. The desktop uses its own offline display and filesystem. Mousepad and Writer are the available applications. Stage conversation files by ID and publish supported outputs from `/workspace/outputs`. Code-assisted interaction runs separately through Part 2’s Shell sandbox and requires its pinned workspace image.
- **Local desktop.** In Tools, select a reviewed editor window for the current conversation. The macOS helper uses the ScreenCaptureKit picker and Accessibility for TextEdit. The Windows helper targets an approved Notepad HWND with Graphics Capture and UI Automation. Window selection, permissions, and successful capture are checked before the environment is offered to the primary. The local adapters accept scoped editor actions and require separate consent before sending an image to the primary. Linux local input has no driver.

```sh
docker build -t aria-virtual-desktop apps/desktop/virtual-desktop
docker image inspect aria-virtual-desktop --format '{{.Id}}'
```

## Execution and data

Electron main owns each foreground lease. Switching conversations, taking control, and stopping input invalidate earlier observation references. Provider action batches pass the same checks and approval prompts as Aria calls. The API forwards authorized observations only to the current primary. Browser and virtual desktop action records distinguish submitted input from verified results. An interrupted attempt can be uncertain even when the provider finished generating its tool call.

The runtime migrates its SQLite schema to version 2. It stores session ownership, status and safe restore metadata, approval decisions, and computer artifact sources. A browser restore opens a fresh profile. A virtual desktop restore requires the same authorized container to still be alive and match its isolation settings. Both require a fresh observation. Local desktop requires a new OS selection. Frames are bounded and transient. Published downloads and outputs use the existing artifact store and retention policy.

## Verification

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm licenses:check`, and `pnpm --filter @aria/desktop test:electron`. Keep provider protocol fixtures separate from live provider probes. On each shipping OS, verify window selection, OS permission revocation, scale changes, and teardown with a synthetic document. Verify the graphical image on the configured Docker host with real capture, input, save, and cleanup before advertising it. Keep disconnected or unsupported combinations unavailable. Real accounts, transactions, communications, and destructive operations stay outside automated fixtures.
