# Execution and knowledge in Aria

Conductor discovers and calls Shell, document search, executable skills, and artifact publishing through ordinary chat. Electron main checks ownership, manages local storage, prompts for transfers, and brokers execution. The model chooses when to use these operations. Part 2’s runtime is available in managed desktop text chat.

## Managed execution

In **Settings → Tools → Execution and knowledge**, enter the endpoint of a local Docker Desktop Linux engine or a rootless Docker Engine on Linux with cgroups v2 and seccomp. Use a Unix socket on macOS/Linux or a Docker named pipe on Windows. The runtime reports the actual endpoint check. Install the pinned OCI image before opening a workspace.

```sh
docker pull docker.io/library/python@sha256:c5ba3deef00c7758561a0f03c26f44f10589263d40e732b8748e0d1f38f6dd89
```

Inputs and reviewed scripts stay read-only. Commands operate as a non-root user in an offline container with bounded CPU, memory, process count, storage, and time. Workspaces retain files for a bounded session. The broker stages individually approved, checksum-verified public HTTPS downloads. Durable execution records preserve attempt IDs and outcomes. A timed-out workspace is revoked, and an ambiguous dispatch is left for inspection.

## Knowledge and artifacts

Attach documents in chat or add them to a library and enable that library for chat. PDF, DOCX, XLSX, PPTX, and text extraction is local. Search indexes authorized versions lazily. User confirmation controls which file excerpts reach the configured primary. Citations identify the original version and show the actual passage. Image-only PDFs need OCR.

For offline semantic and hybrid ranking, obtain the pinned [multilingual ONNX pack](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/tree/2c4055b12046f11709e9df2c122e59ffbdc2f900). Put `tokenizer.json` and `tokenizer_config.json` in the selected directory and `model_quantized.onnx` in its `onnx` subdirectory. Select that directory from **Install local embedding pack**. Aria checks every file against its expected SHA-256 before enabling inference. Keyword and phrase search use SQLite FTS5.

For remote semantic and hybrid ranking, enable an embedding model on an HTTPS connection in **Settings → AI Models**. If the catalog lists only the model ID, declare **Embeddings** under that model’s **Capabilities**. Save AI Models, select the model in **Tools → Execution and knowledge**, and click **Verify and save embedding**. Aria sends synthetic inputs to `/embeddings` and saves the selection after receiving valid vectors. Runtime settings have their own save action. Document passages and queries require separate approval before transfer to the embedding provider.

Use an artifact's card to preview, save, or attach it to a draft. Local artifacts receive opaque IDs after verification. Executable example skills are packaged with Aria and use the managed workspace.

## OpenAI provider modes

Verify each mode individually in **Settings → Tools**. Verification is bound to the primary, endpoint, and credential. Hosted Shell and OpenAI File Search are separate operations that require approval before sending full file contents. Hosted containers use scoped inputs and explicit network policy. Results are correlated using Responses call identifiers. Native indexing is scoped to the selected attached versions, with provider expiration and cleanup at the end of the turn.

The managed Shell probe verifies a native Responses call and a synthetic result round trip. Use **Save and test environment** to verify the separate Docker execution environment. The File Search probe uploads a synthetic document, verifies retrieval from its scoped index, and cleans up both resources.

## Verification

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm licenses:check`, and the built Electron suite. Set `ARIA_TEST_DOCKER_ENDPOINT` to exercise the real workspace and set `ARIA_TEST_EMBEDDING_PACK` to exercise the pinned local inference pack. Native OpenAI Settings probes use synthetic content and require an authorized account. Fixture tests use local mock provider traffic.

A local fixture benchmark compared Part 1 commit `12fbfa1` with Part 2’s
runtime descriptors enabled. Each ran five warmups and twenty measured
direct chat turns through the same loopback provider. Both used one primary
request per turn and emitted zero tool activity. Median and p95 first-delta
latency were 4.81 ms and 5.33 ms in Part 1, and 4.95 ms and 5.75 ms in Part 2.
The provider request grew from 4,377 to 4,980 bytes with the new capability
guidance. These results measure the local fixture.
