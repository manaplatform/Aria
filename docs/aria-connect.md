# Aria Connect

Aria Connect is the desktop integration platform for external apps. GitHub is the first provider. The configured primary discovers GitHub tools through Conductor in ordinary saved chats and reviewed Agenda and Automation runs. Select **Connect** to sign in through your system browser. Aria uses the OS credential store to keep you connected between launches. On Linux, use a supported desktop keyring.

## Connecting GitHub

1. Open **Settings → Connectors**, choose **GitHub**, and select **Connect**.
2. Aria shows a temporary verification code and opens `https://github.com/login/device` in your system browser. Sign in to the intended GitHub account, enter the code shown in Aria, and authorize Aria Connect. Use only a code from the Aria Settings panel you just opened. Never authorize a code sent by someone else.
3. If repository access is needed, open **Manage repositories on GitHub**, install the App, and choose repositories. An organization owner may need to approve installation. If the organization requires SSO, establish the session on GitHub before reconnecting.
4. Select **Test connection**, choose the repositories Aria may use, and select **Review repository access**. The native review names the account, selected repositories, and configured primary model and endpoint.
5. Use ordinary chat to ask about an authorized repository. Change **Aria permissions** when you want to review writes individually or permit eligible operations on specific repositories. The initial policy is read only. GitHub itself grants the repository permissions shown on its installation page.

Use **Add account** to authorize a second identity and the account picker to select which identity foreground chat uses. Reconnect requests verify the original GitHub user. A primary change requires renewed repository approval. **Disconnect this device** deletes Aria’s local credentials. **Revoke on GitHub** disconnects this device and opens GitHub’s **Authorized GitHub Apps** settings. Sign in as the named account and revoke Aria Connect there to revoke its GitHub authorization across devices. [GitHub revocation instructions](https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps)

After signing in, ask ordinary chat to find a public GitHub repository by name or `owner/name`. Aria searches through GitHub’s API using the active account’s stored token, even before an App installation or repository review. Results contain public links and repository metadata. To read repository contents, search within a repository, or use write tools, install the App and review repository access first. [GitHub repository search API](https://docs.github.com/en/rest/search/search#search-repositories)

GitHub content enters the selected primary’s context as evidence. Private GitHub-derived replies stay visible in local chat history. Later turns retrieve private evidence through the current authorization. The assistant’s activity and Settings history show repository targets, verified results, and GitHub source links.

## Maintain the official GitHub App

Confirm the official registration in the `manaplatform` organization before creating another App. If registration is needed, use **Aria Connect** as the production name if available and [the Aria repository](https://github.com/manaplatform/Aria) as its homepage. Use a separate development App and a disposable repository for maintainer experiments.

| GitHub App setting | Value |
| --- | --- |
| Installations | Public, so users can install it on personal and organization accounts on GitHub.com |
| Repository selection | Choose specific repositories in GitHub’s installer |
| User-to-server token expiration | Enabled |
| Request user authorization during installation | Disabled. Aria starts Device Flow separately. |
| Enable Device Flow | Enabled under **Identifying and authorizing users** |
| Webhooks | Disabled |
| Required repository permissions | Metadata read. Contents, Issues, Pull requests, and Actions write. |
| Optional repository permissions | Workflows write for explicitly approved workflow-file changes |
| Account, organization, or enterprise permissions | Leave unset |

Record the App’s public **client ID** and **slug** as `github.clientId` and `github.slug` in the [connector manifest](../apps/desktop/electron/connectors/providers.json). This manifest is bundled into Electron main for both development and packaged Aria. The user access token acts within the permissions of the authenticated GitHub user and the installed App. Organization owners govern installation scope, SSO, and branch rules. [Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) · [Choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)

If the official registration cannot be confirmed, leave the manifest entry `null`. Aria reports a build configuration issue in Settings, and publication fails. Production release preparation checks the public identity and owner at the selected commit and verifies that GitHub accepts Device Flow. Native builds must also pass connector smoke tests before they qualify for publication. Publish from a commit that contains the verified registration and the passing checks.

Users need no `.env`, App registration, personal access token, client secret, or authorization broker. For a separate App, maintainers can set `ARIA_DEV_GITHUB_CLIENT_ID` and `ARIA_DEV_GITHUB_APP_SLUG` together in the launch environment of `pnpm dev:desktop`. An incomplete or invalid pair disables GitHub for that launch. Packaged builds ignore these overrides. Device Flow uses GitHub’s own endpoints. [Enable Device Flow](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#enabling-or-disabling-the-device-flow)

## Authorization and recovery

Electron main requests a device code and displays the short user verification code in trusted Settings. It opens GitHub’s fixed verification URL and polls at GitHub’s interval until the user authorizes, declines, cancels locally, or the code expires. Closing Aria discards an unfinished attempt. Existing connections persist across restart. Aria refreshes expiring device-issued tokens directly with GitHub and saves the replacement pair atomically. If GitHub rotated a token but the replacement could not be saved, a later definitive rejection asks the user to reconnect. [GitHub device authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token) · [GitHub token refresh](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)

Runtime SQLite v11 discards legacy browser-code credentials and keeps account records and activity. Existing connections appear as **Reconnect required**. Reconnect as the same GitHub user and review repositories to resume read-only access. Former selections still available at GitHub are preselected for review. Renew any scheduled scope and write approvals you want to use with the new connection. After a live Device Flow test on the existing GitHub App and a check for external consumers, maintainers can remove its unused legacy callback and retire the previous service and associated GitHub client secret.

## Execution and data boundaries

- Access and refresh tokens are encrypted as one record with the existing OS-backed cipher. Shared refresh and generation checks prevent concurrent replacement or revival of a disconnected connection. A downgrade requires a matching profile backup.
- The main process checks provider installation scope, stable repository identity, Aria repository selection, operation permissions, and the current execution. The Settings renderer receives sanitized account projections and the short user verification code. The device code and tokens stay in Electron main. The model receives verified, bounded operation results and sources.
- High-impact writes require native confirmation. GitHub validates branch protection and organization policies. A write starts a durable dispatch receipt immediately before the provider call. If the result is uncertain, inspect the GitHub target before trying again. GitHub’s response to a request such as cancelling a workflow may precede the final state.
- GitHub code search follows GitHub’s default-branch index. Document, diff, log, and asset retrieval uses bounded requests. Repository file and log instructions never confer authority. Release assets are presented as downloadable binary artifacts through existing desktop ownership and publication checks.
- Agenda and Automations store only the reviewed connection and scope references. Use a recurring instruction for status reports and review reminders, or a **GitHub watch** for a new published release or failed workflow run. The first verified observation establishes a baseline. Background writes wait for exact one-use approval. A revoked or changed connection blocks affected work and requires a renewed review through the existing scheduler.

## Verification

Run the repository’s `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:electron`, `pnpm release:test`, and `pnpm licenses:check`. The Electron fixture covers Settings, the browser handoff, repository review, ordinary chat discovery, token redaction, and refresh after restart. The release matrix exercises the bundled identity and OS credential store with deterministic GitHub responses on macOS, Windows, and Linux.

For live release acceptance, install the official App on a disposable repository. Use a checkout without a local `.env` and leave both development override variables unset. Test with `pnpm dev:desktop` and with the installed macOS DMG, Windows EXE, and Linux packages. Authorize in the browser, approve the disposable repository for your configured primary model, ask ordinary chat to read its README, then restart and repeat the read. Record the real GitHub results separately from fixture results.

For an interactive browser verification through the Playwright harness, set `ARIA_RUN_LIVE_GITHUB_CONNECT=1` and `ARIA_TEST_GITHUB_REPOSITORY=owner/repository`. Set `ARIA_TEST_PACKAGED_APP` to the installed executable to use it instead of the local build. Enter the temporary code from Aria Settings in the default browser when it opens.

```sh
pnpm --filter @aria/desktop exec playwright test connectors.electron.ts --grep 'live GitHub App'
```

Verify GitHub organization approval, selected repository enforcement, and one disposable mutation in staging before production enablement.
