import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Hostnames the dev/preview server will answer to, in addition to localhost.
 * Vite rejects unknown Host headers as a DNS-rebinding safeguard; a leading
 * dot allows a domain and all its subdomains. `.ts.net` covers Tailscale
 * MagicDNS names (reach the dev server from another device on your tailnet).
 */
const allowedHosts = ['.ts.net'];

// Where the backend API lives during development. The web dev server proxies
// `/api` here so the browser talks to one origin (no CORS), matching the
// production single-origin deployment.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'favicon.svg'],
      manifest: {
        name: 'CountRoster',
        short_name: 'CountRoster',
        description: 'Track anything — habits, meds, symptoms, spending, moods.',
        theme_color: '#1f2933',
        background_color: '#1f2933',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Don't let the service worker cache API calls — data must be live.
        navigateFallbackDenylist: [/^\/api/],
      },
    }),
  ],
  server: {
    allowedHosts,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    allowedHosts,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
});
