# Aria Connect

Aria Connect is the desktop integration platform for external apps. GitHub is the first provider. The configured primary discovers GitHub tools through Conductor in ordinary saved chats and reviewed Agenda and Automation runs. Connecting requires the system browser and an available OS-backed credential store.

## Connecting GitHub

1. Open **Settings → Connectors**, choose **GitHub**, and select **Connect**.
2. Sign in and authorize Aria Connect at GitHub. Return to Aria when the browser shows the completion page.
3. If repository access is needed, open **Manage repositories on GitHub**, install the App, and choose repositories. An organization owner may need to approve installation. If the organization requires SSO, establish the session on GitHub before reconnecting.
4. Select **Test connection**, choose the repositories Aria may use, and select **Review repository access**. The native review names the account, selected repositories, and configured primary model and endpoint.
5. Use ordinary chat to ask about an authorized repository. Change **Aria permissions** when you want to review writes individually or permit eligible operations on specific repositories. The initial policy is read only. GitHub itself grants the repository permissions shown on its installation page.

Use **Add account** to authorize a second identity and the account picker to select which identity foreground chat uses. Reconnect requests verify the original GitHub user. A primary change requires renewed repository approval. **Disconnect this device** deletes Aria’s local credentials. **Revoke on GitHub** additionally revokes the GitHub App user grant across devices. A local disconnect takes effect even when the broker is unavailable.

GitHub content enters the selected primary’s context as evidence. Private GitHub-derived replies stay visible in local chat history. Later turns retrieve private evidence through the current authorization. The assistant’s activity and Settings history show repository targets, verified results, and GitHub source links.

## Register a GitHub App

Create an App owned by the Aria maintainer organization. Use **Aria Connect** as the production name if available and [the Aria repository](https://github.com/manaplatform/Aria) as its homepage. Use a separate name, account registration, client secret, and HTTPS broker for development.

| GitHub App setting | Value |
| --- | --- |
| User authorization callback | `https://<broker-origin>/v1/github/callback` |
| Installations | Personal and organization accounts on GitHub.com |
| Repository selection | Choose specific repositories in GitHub’s installer |
| User-to-server token expiration | Enabled |
| Request user authorization during installation | Disabled. Aria starts OAuth separately. |
| Device flow and webhooks | Disabled in this deployment |
| Required repository permissions | Metadata read. Contents, Issues, Pull requests, and Actions write. |
| Optional repository permissions | Workflows write for explicitly approved workflow-file changes |
| Account, organization, or enterprise permissions | Leave unset |

Record the App’s **client ID** and **slug**. Create a **client secret** in GitHub and install it in the broker host’s secret manager. The user access token acts within the intersection of the authenticated GitHub user and installed App permissions. Organization owners govern installation scope, SSO, and branch rules. The application uses GitHub.com APIs and does not need an App private key. [Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) · [Choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) · [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)

## Deploy the authorization broker

Build the standalone Node service and its container from the repository root.

```sh
pnpm --filter @aria/connector-auth-broker build
docker build -t aria-connect-broker apps/connector-auth-broker
```

Run one replica behind HTTPS ingress. Supply `ARIA_CONNECT_ORIGIN` as the exact public HTTPS origin with no path or trailing slash, `GITHUB_CLIENT_ID` as the App client ID, and `GITHUB_CLIENT_SECRET` through the host’s secret manager. The private listener uses `PORT` or 8080, and `GET /health` verifies the service is accepting requests. Preserve the public Host header and terminate TLS at the ingress. Limit access to the private listener and allow outbound HTTPS to GitHub’s OAuth and REST origins. Disable request and response body logging, authorization header logging, and query logging on the callback. Monitor route class, status, latency, and request volume. Enforce a per-source ingress limit as well as the broker’s global limits.

Build Aria with three public GitHub Actions variables or local packaging environment values.

| Public configuration | Value |
| --- | --- |
| `ARIA_CONNECT_ORIGIN` | Exact broker HTTPS origin |
| `ARIA_CONNECT_GITHUB_CLIENT_ID` | App client ID |
| `ARIA_CONNECT_GITHUB_APP_SLUG` | Slug from the App’s GitHub URL |

Packaged Aria reads these values from its bundled resource. Local development reads the same public environment variables. Builds without this configuration show GitHub as unavailable. Keep broker secrets outside desktop packaging, local NestJS, shell, and model configuration.

### Broker flow and recovery

Electron main generates OAuth state, a PKCE S256 verifier, and a separate desktop proof. The broker accepts a single callback for the live state and redirects to a static page with a scrubbed URL. Only the initiating desktop can redeem the code, using both proofs. The broker exchanges authorization codes, refreshes rotating tokens, and revokes grants. GitHub repository traffic goes directly from Electron main to GitHub.

Broker sessions are kept in bounded memory for ten minutes. An interrupted sign-in can be restarted. Established connections retain their encrypted token pairs across desktop and broker restarts. If GitHub rotates credentials but a network or storage failure prevents Aria from saving the new pair, the next definitive invalid refresh requests reconnection. Existing unexpired tokens can continue to serve authorized operations during a broker outage.

For a broker deployment or secret rotation, verify the health endpoint and complete a sign-in and refresh with the development App, then deploy the production secret and verify the production service. To roll back, restore the last healthy broker build while retaining the same registered origin and correct current secret. Redirects and PKCE remain bound to the configured App. GitHub device flow is an alternative architecture with a user-code step and different refresh requirements. The desktop uses the registered browser flow throughout. [GitHub token refresh](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)

## Execution and data boundaries

- Runtime SQLite v10 adds connector accounts, activity, and watch baselines. Access and refresh tokens are encrypted as one record with the existing OS-backed cipher. Shared refresh and generation checks prevent concurrent replacement or revival of a disconnected connection. A downgrade requires a matching profile backup.
- The main process checks provider installation scope, stable repository identity, Aria repository selection, operation permissions, and the current execution. The broker, Settings renderer, model, and workspace shell have separate interfaces. The renderer receives sanitized account projections. The model receives verified, bounded operation results and sources.
- High-impact writes require native confirmation. GitHub validates branch protection and organization policies. A write starts a durable dispatch receipt immediately before the provider call. If the result is uncertain, inspect the GitHub target before trying again. GitHub’s response to a request such as cancelling a workflow may precede the final state.
- GitHub code search follows GitHub’s default-branch index. Document, diff, log, and asset retrieval uses bounded requests. Repository file and log instructions never confer authority. Release assets are presented as downloadable binary artifacts through existing desktop ownership and publication checks.
- Agenda and Automations store only the reviewed connection and scope references. Use a recurring instruction for status reports and review reminders, or a **GitHub watch** for a new published release or failed workflow run. The first verified observation establishes a baseline. Background writes wait for exact one-use approval. A revoked or changed connection blocks affected work and requires a renewed review through the existing scheduler.

## Verification

Run the repository’s `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:electron`, and `pnpm licenses:check`. The broker and desktop suites use deterministic fixtures. The built Electron connector test exercises Settings, the browser handoff, repository review, ordinary chat discovery, and token redaction.

For live verification, install the development App on a disposable repository and set `ARIA_TEST_GITHUB_REPOSITORY=owner/repository`. Launch the explicit opt-in test with the three public configuration values and `ARIA_RUN_LIVE_GITHUB_CONNECT=1`. When verifying an installed desktop package, set `ARIA_TEST_PACKAGED_APP` to that executable. Complete GitHub authorization in the default browser when it opens.

```sh
pnpm --filter @aria/desktop exec playwright test connectors.electron.ts --grep 'live development GitHub App'
```

Repeat on the supported macOS, Windows, and Linux targets with their normal credential stores. Reopen Aria with the same profile to verify credential reuse. Verify GitHub organization approval, selected repository enforcement, and one disposable mutation in staging before production enablement.
