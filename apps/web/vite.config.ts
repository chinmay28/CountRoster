import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The OPFS-backed sqlite-wasm VFS requires the page to be cross-origin
 * isolated (it uses SharedArrayBuffer). That needs these two response
 * headers on every document/worker response:
 *
 *   Cross-Origin-Opener-Policy:   same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * We set them for `vite dev` and `vite preview`. In production the host
 * (Netlify/Vercel/static server) must send the same headers — see
 * DEPLOYMENT.md and `public/_headers`. When isolation is absent the app
 * still boots via an in-memory fallback (see src/db/adapter.ts).
 */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: {
    headers: crossOriginIsolation,
  },
  preview: {
    headers: crossOriginIsolation,
  },
  // sqlite-wasm ships its own worker/wasm assets and does not play well with
  // Vite's dependency pre-bundling. Let it be loaded as-is.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  worker: {
    format: 'es',
  },
});
