import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { rendererNotices } = createRequire(import.meta.url)('./scripts/third-party.cjs') as {
  rendererNotices(bundle: unknown): unknown;
};
const rendererLicenseInventory: Plugin = {
  name: 'aria-renderer-license-inventory',
  apply: 'build',
  generateBundle(_options, bundle) {
    this.emitFile({
      type: 'asset',
      fileName: 'renderer-licenses.json',
      source: JSON.stringify(rendererNotices(bundle)),
    });
  },
};
export default defineConfig(({ command }) => {
  const nonce = command === 'serve' ? randomBytes(18).toString('base64') : undefined;
  return {
    base: './',
    // AudioWorklet modules must remain same-origin files under the renderer CSP.
    build: {
      assetsInlineLimit: (file) => (file.endsWith('microphone-worklet.js') ? false : undefined),
    },
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    html: { cspNonce: nonce },
    plugins: [
      react(),
      tailwindcss(),
      rendererLicenseInventory,
      ...(nonce
        ? [
            {
              name: 'aria-dev-csp',
              transformIndexHtml: (
                html: string,
                context: { server?: { config: { server: { port?: number } } } },
              ) =>
                html
                  .replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`)
                  .replace(
                    'ws://127.0.0.1:5173',
                    `ws://127.0.0.1:${context.server?.config.server.port ?? 5173}`,
                  ),
            },
          ]
        : []),
    ],
    server: { host: '127.0.0.1', strictPort: true },
  };
});
