# Releasing Aria

Aria Release Creator builds and verifies desktop packages on GitHub-hosted runners. The root [package.json](../package.json) is the application version source. The other workspace package versions identify internal packages.

## Create a release

1. Change the root application version and merge the reviewed change into `main`. Use a final SemVer such as `1.2.3` for stable or a prerelease such as `1.2.4-beta.1` for beta. Keep the major component at or below 9999 and the minor and patch components at or below 99 for the macOS bundle fields. Build metadata is excluded from release versions because it has equal update precedence.
2. Open **Actions → Aria Release Creator** to follow the run. A version change starts the build automatically. The protected publish job runs after all six platform builds pass. Stable becomes the GitHub latest release. Beta is published as a prerelease.
3. For the first release or to release the current default-branch version manually, use **Run workflow → publish** or `pnpm release:create`. Use `preview` to generate metadata and notes, or `verify` to produce verification artifacts without a GitHub Release. Windows verification uses a disposable signing certificate. The workflow must already be present on the default branch to dispatch it.

```sh
pnpm release:check
pnpm release:preview
pnpm release:notes
pnpm release:create --dry-run
```

The preview reads GitHub’s tags, releases, and pull requests. It uses the local root version and checked-out commit. It lists expected filenames, and the preview tag is provisional until the production job reserves it. Authenticate `gh` for higher API limits when needed. The snapshot should come from a full clone.

```sh
gh workflow run release.yml --repo manaplatform/Aria --ref main -f mode=verify
gh api --method POST repos/manaplatform/Aria/actions/workflows/release.yml/dispatches \
  --input - <<'JSON'
{"ref":"main","inputs":{"mode":"preview"}}
JSON
```

The application version and calendar tag are independent. The publish job reserves an annotated UTC tag such as `v2026.11.22`. Additional versions on that UTC date get `-2`, `-3`, and subsequent suffixes. A reservation records the application version and source commit, so retrying after midnight retains the tag and title date. Release notes combine Git history since the last published ancestor with merged PR titles, labels, Conventional Commits, and GitHub’s generated notes. Use `skip-release-notes` on a PR when appropriate. First releases use repository history.

## Production setup

Confirm first-party distribution terms and review the dependency and runtime notices. The repository owner sets `ARIA_DISTRIBUTION_AUTHORIZED=true` only after that review. Create the `aria-release`, `aria-windows-signing`, `aria-macos-signing`, and `aria-linux-signing` GitHub environments and restrict each to the protected default branch. The verification environment handles builds without production credentials. All jobs use GitHub-hosted runners. You can enable immutable releases in the repository for additional protection after publication.

| Location | Settings |
| --- | --- |
| Repository variables | Set `ARIA_RELEASE_ENABLED=true` when ready to activate. Set `ARIA_DISTRIBUTION_AUTHORIZED=true` after review. Set `ARIA_UPDATE_PUBLIC_KEYS` to the comma-separated base64 DER (SPKI) Ed25519 trust keys. |
| `aria-release` secret | `ARIA_UPDATE_PRIVATE_KEY` is the active base64 DER (PKCS#8) Ed25519 private key. Its public key must appear in `ARIA_UPDATE_PUBLIC_KEYS`. |
| `aria-windows-signing` secrets | `WIN_CSC_LINK` contains the base64 password-protected PFX for Aria’s self-signed Authenticode cert. `WIN_CSC_KEY_PASSWORD` contains the PFX password. |
| `aria-windows-signing` variables | `ARIA_WINDOWS_SIGNER_SHA256` is the SHA-256 hash of the signing certificate’s DER bytes, in hex without separators. `ARIA_WINDOWS_ADDITIONAL_SIGNERS_SHA256` may contain comma-separated successor pins for rotation. |
| `aria-macos-signing` secrets | `CSC_LINK` contains the base64 Developer ID Application P12. `CSC_KEY_PASSWORD` holds its password. `APPLE_API_KEY_BASE64` holds the base64 App Store Connect notarization P8 file. |
| `aria-macos-signing` variables | `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` identify the notarization API key and issuer. |

Generate and store signing keys outside the checkout. Publish only the public Windows certificate and its fingerprint. Use an end-entity, self-signed code-signing certificate with the code-signing EKU. Export a DER public certificate to compute its SHA-256 fingerprint. Aria’s Windows packaging verifies that the PFX matches the configured fingerprint and uses SHA-256 with RFC 3161 timestamps. For managed devices, distribute the public certificate through your organization’s Windows trust policy and verify the published fingerprint before enrollment. Authenticode updates require both a valid Windows trust result and a match to a fingerprint bundled in Aria. SmartScreen or Smart App Control can still warn or block self-signed EXEs. [Microsoft SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

For key rotation, ship the successor fingerprint or update public key while the current key remains active. Allow the transition release to reach clients and configure managed Windows trust for the successor before switching signing. Preserve the macOS bundle ID and Developer ID team to keep the app’s existing identity.

Keep production variables disabled during acceptance testing. Before activation, verify the first signed candidate with Windows device trust and Gatekeeper on the supported machines.

## Retry and verify

Use **Re-run failed jobs** to retry a failed workflow at its original commit. Rerun all jobs if Actions artifacts have expired. A failed build produces no draft. After tag reservation, retries reuse the version’s tag and recover its draft. Uploaded assets with matching hashes are retained and missing or mismatched owned draft assets are repaired. Review any unexpected assets before retrying. A published version cannot be reused by a different commit. Use a new version for a correction after publication.

Download the installer for your platform and architecture. Compare the file hashes with `SHA256SUMS.txt` and verify build provenance with `gh attestation verify <file> --repo manaplatform/Aria`. On Windows compare `Get-FileHash -Algorithm SHA256` and inspect the file's Authenticode publisher and certificate fingerprint. On macOS use `shasum -a 256`, Gatekeeper, and `xcrun stapler validate`. Linux users can use `sha256sum -c SHA256SUMS.txt --ignore-missing` from the download directory. The signed release manifest also records each asset’s size, URL, and digest.

## Desktop updates

**Settings → Updates** shows the installed version and preferred channel. Stable checks final app versions. Beta checks both prereleases and final versions and selects the highest compatible SemVer greater than the installed version. GitHub’s calendar tags identify downloads and are independent of update precedence. The updater verifies the signed release manifest and the target metadata before downloading, then validates the downloaded package. Windows enforces the signer pin and OS trust. macOS verifies the installed signing identity through its native updater.

Use **Install and restart** on NSIS, macOS, or a writable AppImage installation. The existing shutdown flow saves desktop data before handing off to the installer. Portable Windows builds and DEB, RPM, and TAR.GZ users can open the verified release and update through their existing installation method.

The release test suite verifies failing GitHub operations and rejected manifests in fixtures. Native package verification launches Aria with a temporary profile and a loopback provider, then exercises chat and profile persistence. Production acceptance also uses a pair of signed test versions to verify download, install, restart, and preservation of conversations, settings, and standing permissions on the target OS. Keep signed test artifacts and the fixture feed outside the public release channel.
