# Third-party notices

Aria uses Electron, which distributes Chromium, Node.js, and third-party components. Retain Electron's `LICENSE` and `LICENSES.chromium.html` from the exact runtime distributed with Aria. The project's license does not change the terms for those components.

After building the desktop app and installing its Electron runtime, run `pnpm licenses:check`. This generates the shipped dependency inventory and available upstream notice text in `apps/desktop/dist/third-party/`. The inventory covers the staged NestJS API, Electron main-process runtime dependencies, and packages found in the built renderer chunks. Include these files in distributions. The generated renderer inventory also identifies original license files associated with bundled code.

The recorded notice for `@ai-sdk/provider-utils@5.0.79` comes from its [tagged upstream release](https://github.com/vercel/ai/blob/44ba949048fcfe4cd1b801c3bd9c49bffbad96fa/LICENSE).

Review entries flagged by the check for absent metadata, absent license files, or additional terms. Review generated CSS, embedded assets, trademarks, and any installer-specific additions separately. No standalone image, icon, or font asset was tracked at the start of this change. Aria's own name and marks require a separate ownership and trademark review before adding an open-source notice.

See [Electron's license](https://github.com/electron/electron/blob/main/LICENSE) and the license notices included with each published Electron binary.

The opt-in local embedding pack is a pinned ONNX export of the Apache-2.0
paraphrase-multilingual-MiniLM-L12-v2 model. Its model and tokenizer data are
installed separately. The optional managed sandbox uses a digest-pinned
Docker Official Python image. The bundled renderer dependency inventory
covers the document and ONNX runtime libraries.
