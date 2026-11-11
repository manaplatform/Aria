import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig(({ command }) => {
  const nonce = command === 'serve' ? randomBytes(18).toString('base64') : undefined;
  return {
    base: './',
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    html: { cspNonce: nonce },
    plugins: [
      react(),
      tailwindcss(),
      ...(nonce
        ? [
            {
              name: 'aria-dev-csp',
              transformIndexHtml: (html: string) =>
                html.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`),
            },
          ]
        : []),
    ],
    server: { host: '127.0.0.1', strictPort: true },
  };
});
