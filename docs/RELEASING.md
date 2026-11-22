# Releasing Aria

Aria Release Creator builds and verifies desktop packages on GitHub-hosted runners. The root [package.json](../package.json) is the application version source. The other workspace package versions identify internal packages.

## Create a release

### From GitHub Releases

1. Open [Aria Releases](https://github.com/manaplatform/Aria/releases) and select **Draft a new release**.
2. In **Choose a tag**, select an existing calendar tag such as `v2026.11.23.2`. The tag must point to a commit in the history of `main`.
3. Leave the description and assets empty and select **Save draft** to request automatic publication.

Release Creator checks for new requests every 15 minutes, subject to GitHub Actions scheduling. It builds the tagged commit, sets the title to the application version from that commit's root `package.json`, and links the draft to the workflow. For example, tag `v2026.11.23.2` for Aria 0.0.1 gets the title `v0.0.1`. It publishes the same draft and tag with generated release notes, verified installers, checksums, and update metadata. Keep the draft saved while the workflow is running. [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)

### From a version change

1. Change the root application version and merge the reviewed change into `main`. Use a final SemVer such as `1.2.3` for stable or a prerelease such as `1.2.4-beta.1` for beta. Keep the major component at or below 9999 and the minor and patch components at or below 99 for the macOS bundle fields. Build metadata is excluded from release versions because it has equal update precedence.
2. Open **Actions → Aria Release Creator** to follow the run. The workflow compares the root versions before and after a push to `main` and starts the build when the version changes. The protected publish job runs after all six platform builds pass. Stable becomes the GitHub latest release. Beta is published as a prerelease.
3. For the first release or to release the current default-branch version manually, use **Run workflow → publish** or `pnpm release:create`. Use `preview` to generate metadata and notes, or `verify` to produce packages, verification receipts, and build provenance without a GitHub Release. Windows verification uses a disposable signing certificate. The workflow must already be present on the default branch to dispatch it.

```sh
pnpm release:check
pnpm release:preview
pnpm release:notes
pnpm release:create --dry-run
```

The preview reads GitHub’s tags, releases, and pull requests. It uses the local root version and checked-out commit. The preview lists expected filenames and renders the available release notes. Publication adds download links after verifying the uploaded bytes. The preview tag is provisional until the production job reserves it. Authenticate `gh` for higher API limits when needed. The snapshot should come from a full clone with the release history.

```sh
gh workflow run release.yml --repo manaplatform/Aria --ref main -f mode=verify
gh api --method POST repos/manaplatform/Aria/actions/workflows/release.yml/dispatches \
  --input - <<'JSON'
{"ref":"main","inputs":{"mode":"preview"}}
JSON
```

The application version and calendar tag are independent. If no matching draft exists, the publish job prepares the signed manifest and `SHA256SUMS.txt`, then reserves an annotated UTC tag such as `v2026.11.22`. Additional versions on that UTC date get `-2`, `-3`, and subsequent suffixes. A reservation records the application version and source commit, so retrying after midnight retains the tag. The release title is `v{VERSION}`.

Release Creator renders the [Markdown template](../scripts/release/release-notes.md) from the tagged source and the verified uploads. Highlights use actual commit subjects, merged PR titles and labels, and Conventional Commits. Empty categories are omitted. Stable notes cover changes since the last stable release with assets on the source branch. Beta notes can also use a previous prerelease with assets. The first release with assets uses repository history. Apply `skip-release-notes` to omit a PR from the highlights. The full changelog remains available through GitHub.

Download and installation sections reflect the uploaded packages for each architecture. The notes link to checksums, the signed manifest and signature, the software bill of materials, and the public Windows signing certificate. First-party license details come from the root package metadata and tracked license files, with a separate link to third-party notices when available.

## Production setup

Confirm first-party distribution terms and review the dependency and runtime notices. The repository owner sets `ARIA_DISTRIBUTION_AUTHORIZED=true` after that review. Create the `aria-release`, `aria-windows-signing`, and `aria-linux-signing` GitHub environments and restrict each to the protected default branch. Configure `aria-release-verification` to run verification builds and both macOS production builds without production secrets or required reviewers. Allow the branches used for verification. The workflow limits production macOS builds to the default branch. You can enable immutable releases in the repository for additional protection after publication.

| Location | Settings |
| --- | --- |
| Repository variables | Set `ARIA_RELEASE_ENABLED=true` when ready to activate. Set `ARIA_DISTRIBUTION_AUTHORIZED=true` after review. Set `ARIA_UPDATE_PUBLIC_KEYS` to the comma-separated base64 DER (SPKI) Ed25519 trust keys. |
| `aria-release` secret | `ARIA_UPDATE_PRIVATE_KEY` is the active base64 DER (PKCS#8) Ed25519 private key. Its public key must appear in `ARIA_UPDATE_PUBLIC_KEYS`. |
| `aria-windows-signing` secrets | `WIN_CSC_LINK` contains the base64 password-protected PFX for Aria’s self-signed Authenticode cert. `WIN_CSC_KEY_PASSWORD` contains the PFX password. |
| `aria-windows-signing` variables | `ARIA_WINDOWS_SIGNER_SHA256` is the 64-character SHA-256 hash of the signing certificate’s DER bytes, in hex without separators. Leave `ARIA_WINDOWS_ADDITIONAL_SIGNERS_SHA256` unset or empty when there are no successor pins. For rotation, enter comma-separated fingerprints in the same format. |

Enable GitHub Actions and allow the pinned actions used in both release workflows. The aggregate verification job uses `id-token: write` and `attestations: write`. GitHub provides standard hosted runners and artifact attestations for public repositories on the free plan. Private repositories have different runner quotas and attestation requirements. [Hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) · [Artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

Generate and store signing keys outside the checkout. Publish only the public Windows certificate and its fingerprint. Use an end-entity, self-signed code-signing certificate with the code-signing EKU. Export a DER public certificate to compute its SHA-256 fingerprint. Aria’s Windows packaging verifies that the PFX matches the configured fingerprint and uses SHA-256 with RFC 3161 timestamps. For managed devices, distribute the public certificate through your organization’s Windows trust policy and verify the published fingerprint before enrollment. Authenticode updates require both a valid Windows trust result and a match to a fingerprint bundled in Aria. SmartScreen or Smart App Control can still warn or block self-signed EXEs. [Microsoft SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

For key rotation, ship the successor fingerprint or update public key while the current key remains active. Allow the transition release to reach clients and configure managed Windows trust for the successor before switching signing. Preserve the macOS bundle ID, application name, and profile location across releases.

Keep production activation disabled during acceptance testing. Before activation, check Windows device trust and the macOS first-launch and update procedures on the supported machines. Retire the unused `aria-macos-signing` environment and its credentials once any previously queued runs are no longer needed.

## macOS packages

Electron Builder packages Aria on `macos-15` for Apple Silicon and `macos-15-intel` for Intel. The DMGs use the existing filename pattern `Aria-<version>-macos-<arch>.dmg`. The pipeline also ships ZIP archives. Electron Builder signs the complete app with the ad hoc identity `-`, and the packaging script ad hoc signs the completed DMG. This requires no Apple account, signing certificate, or notarization. The release notes and signed manifest identify the macOS packages as ad hoc signed and unnotarized.

Before upload, the runner verifies the DMG checksum and signature, strictly validates the app seal and nested Mach-O signatures, checks architecture, and launches the installed copy against a fixture provider. It replaces the installed app with the copy from the ZIP and repeats the launch using the same profile. The aggregate job checks the native build receipts and attests the packages. The publish job signs the release manifest and verifies the draft assets before making the release public.

### macOS installation

1. Download the DMG for your Mac, `arm64` for Apple Silicon or `x64` for Intel. Compare its SHA-256 digest with `SHA256SUMS.txt` and verify GitHub build provenance before opening it.
2. Open the DMG and drag Aria to Applications. For an update, quit the running copy before choosing **Replace** in Finder. Start Aria from Applications.
3. If macOS blocks the first launch and you have verified the download, open **System Settings → Privacy & Security** and use **Open Anyway** for Aria if your device policy permits it. Confirm the prompt. A new version may require approval again. Managed Macs may prohibit the exception. [Apple’s instructions for opening apps](https://support.apple.com/en-us/102445)

An ad hoc signature seals the bundle and its nested code. Publisher authenticity comes from the trusted Ed25519 release key and GitHub provenance. macOS treats these packages as unnotarized and may reject them under Gatekeeper policy. Keep Gatekeeper and quarantine enabled.

## Retry and verify

Use **Re-run failed jobs** to retry with the same source commit. Rerun all jobs if Actions artifacts have expired. Draft requests remain linked to their original workflow after a failed build. To request a different source before any assets have been attached, select the tag for that commit, clear the draft description, and save it again. Uploaded assets with matching hashes are retained and missing or mismatched owned draft assets are repaired. Review any unexpected assets before retrying. Every published version occupies its SemVer precedence, including a public release with zero assets. Use a new root version for a correction after publication.

Download the installer for your platform and architecture. Compare the file hashes with `SHA256SUMS.txt` and verify build provenance with `gh attestation verify <file> --repo manaplatform/Aria --source-ref refs/heads/main`. On Windows compare `Get-FileHash -Algorithm SHA256` and inspect the file's Authenticode publisher and certificate fingerprint. On macOS use `shasum -a 256`, `hdiutil verify <image>`, and `codesign --verify --strict <image>`. After mounting the image, use `codesign --verify --deep --strict <path-to-Aria.app>` to check the app seal. Linux users can use `sha256sum -c SHA256SUMS.txt --ignore-missing` from the download directory. The signed release manifest also records each asset’s size, URL, and digest.

## Desktop updates

**Settings → Updates** shows the installed version and preferred channel. Stable checks final app versions. Beta checks both prereleases and final versions and selects the highest compatible SemVer greater than the installed version. GitHub’s calendar tags identify downloads and are independent of update precedence. The updater verifies the signed release manifest and the target metadata before downloading, then validates the downloaded package. Windows enforces the signer pin and OS trust.

On macOS, Aria checks at launch and every six hours while running when a check is due. Choose **Download update**, then **Open disk image**. Aria checks the DMG’s size, SHA-256, and SHA-512 against the signed manifest and marks the download for normal macOS quarantine handling. Quit Aria, replace `Aria.app` in Applications, and relaunch as described above. If you have a build that still expects a ZIP update, use the DMG from the verified GitHub Release to move to this update flow.

Swapping the app bundle keeps Aria’s conversations and settings in `~/Library/Application Support/Aria`. Keep that directory and the Aria Keychain entry when updating. macOS may ask for Keychain access again or require you to re-enter a credential if it cannot reuse the existing access grant. Ad hoc signatures are tied to a specific build. After updating, check **Privacy & Security** for Accessibility and Screen & System Audio Recording, grant access again if prompted, and select the intended window or display again in Aria before allowing desktop control. [Apple’s code-signing requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)

Use **Install and restart** on NSIS or a writable AppImage installation. The existing shutdown flow saves desktop data before handing off to the installer. Portable Windows builds and DEB, RPM, and TAR.GZ users can open the verified release and update through their existing installation method.

The release tests cover GitHub retry behavior, manifest rejection, and download validation. For production acceptance, use two ad hoc signed fixture versions on each Mac architecture. Install the first under a test user, add a conversation, preference, and fixture provider credential, then grant Accessibility and Screen Recording and exercise display sharing and a pointer action. Update through the verified DMG flow and test the same data and operations on the second version. Record which macOS grants survived and any reauthorization prompts. Keep fixture artifacts and credentials out of the public release channel.
