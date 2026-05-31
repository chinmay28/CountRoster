import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
    allowedHosts,
  },
  preview: {
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
