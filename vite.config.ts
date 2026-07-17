import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

// `base` must match `/<repo-name>/` when deployed to GitHub Pages.
// CI sets VITE_BASE; locally falls back to '/' so `npm run dev` works.
const base = process.env.VITE_BASE ?? '/';

/**
 * Dev-only hardening. Vite inlines launch-editor-middleware, which serves
 * `/__open-in-editor` and opens arbitrary paths. On Windows a UNC path
 * (`\\attacker\share`) triggers NTLM auth and leaks the developer's NTLMv2 hash
 * to a remote SMB server (GHSA-v6wh-96g9-6wx3). We don't use "open in editor",
 * so block the route before Vite's handler runs. Registering the middleware
 * directly inside configureServer makes it run BEFORE Vite's internal ones.
 * Only applies to the dev server (`apply: 'serve'`); production is a static
 * build with no such endpoint.
 */
function blockOpenInEditor(): Plugin {
  return {
    name: 'block-open-in-editor',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/__open-in-editor')) {
          res.statusCode = 403;
          res.end('open-in-editor disabled');
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split big third-party deps into their own chunks so the main bundle
        // stays small and these heavy libs cache independently across deploys.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@supabase')) return 'supabase';
          if (id.includes('react-router')) return 'router';
          if (id.includes('react-dom') || /[\\/]react[\\/]/.test(id)) return 'react';
          return 'vendor';
        },
      },
    },
  },
  plugins: [
    blockOpenInEditor(),
    react(),
    VitePWA({
      // 'prompt' — a new build does NOT silently swap in. The app shows a
      // "Yeni sürüm hazır" banner (PwaUpdatePrompt) and the user taps Yenile.
      registerType: 'prompt',
      // 'injectManifest' — we own src/sw.ts end to end. Old generateSW
      // strategy wrapped importScripts() in an async define() callback which
      // ran after the SW's synchronous parse and broke push handler install.
      // See src/sw.ts header for the long story.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['icons/icon-512.png'],
      manifest: {
        name: 'Yönetim',
        short_name: 'Yönetim',
        description: 'Mülk ve rezervasyon yönetimi',
        theme_color: '#059669',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: base,
        scope: base,
        // Single 512×512 PNG covers every icon slot — browsers + iOS downscale
        // as needed. The logo has generous margin so it survives the Android
        // circular maskable crop without clipping.
        icons: [
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
    }),
  ],
});
