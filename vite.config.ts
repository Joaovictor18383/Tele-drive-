import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: { outDir: 'dist/web', target: 'es2022' },
  plugins: [react(), tailwindcss(), VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
    manifest: {
      name: 'CloudVault', short_name: 'CloudVault', lang: 'pt-BR',
      description: 'Drive pessoal com criptografia local',
      start_url: '/', display: 'standalone', theme_color: '#f5f7fc',
      background_color: '#f5f7fc',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    },
    workbox: {
      importScripts: ['/stream.js'],
      navigateFallbackDenylist: [/^\/api\//, /^\/__cloudvault-(?:download|media)\//],
      globPatterns: ['**/*.{js,css,html,png,svg,woff2}']
    }
  })],
  server: {
    host: 'localhost', strictPort: true, port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3000' } }
  }
});
