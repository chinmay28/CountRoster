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

/**
 * Hostnames the dev/preview server will answer to, in addition to
 * localhost. Vite rejects unknown Host headers as a DNS-rebinding
 * safeguard; a leading dot allows a domain and all its subdomains.
 * `.ts.net` covers Tailscale MagicDNS names (e.g. accessing the dev
 * server from another device on your tailnet). Add your own as needed.
 */
const allowedHosts = ['.ts.net'];

export default defineConfig({
  plugins: [react()],
  server: {
    headers: crossOriginIsolation,
    allowedHosts,
  },
  preview: {
    headers: crossOriginIsolation,
    allowedHosts,
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
