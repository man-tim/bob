import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const isProd = process.env.NODE_ENV === 'production'

export default defineConfig({
  // ─── Main process ────────────────────────────────────────────────────────────
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      sourcemap: isProd ? false : 'inline',
      minify: isProd,
    },
  },

  // ─── Preload ─────────────────────────────────────────────────────────────────
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: isProd ? false : 'inline',
      minify: isProd,
    },
  },

  // ─── Renderer ────────────────────────────────────────────────────────────────
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared':   resolve('src/shared'),
      },
    },
    plugins: [react()],
    build: {
      sourcemap: false,
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
        output: {
          // Code-split the renderer into logical chunks so the initial load is fast.
          // Heavy pages (CompanyDetail, FlyerCreator) are loaded on demand.
          manualChunks(id) {
            // ── Core React runtime ──────────────────────────────────────────
            if (id.includes('node_modules/react') ||
                id.includes('node_modules/react-dom') ||
                id.includes('node_modules/react-router')) {
              return 'vendor-react'
            }
            // ── UI utilities ────────────────────────────────────────────────
            if (id.includes('node_modules/lucide-react') ||
                id.includes('node_modules/clsx')) {
              return 'vendor-ui'
            }
            // ── Search / state ──────────────────────────────────────────────
            if (id.includes('node_modules/fuse.js') ||
                id.includes('node_modules/zustand')) {
              return 'vendor-state'
            }
            // ── Heavy pages (lazy-loaded at route level) ────────────────────
            if (id.includes('/pages/CompanyDetail')) return 'page-company-detail'
            if (id.includes('/pages/FlyerCreator'))  return 'page-flyer'
            if (id.includes('/pages/ScrubSplit'))    return 'page-scrub'
          },
        },
      },
    },
  },
})
