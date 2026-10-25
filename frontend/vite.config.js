import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const SW_BUILD_TOKEN = '__CIVICAI_BUILD_ID__'

/** Every file below `dir` (public/ is small: icons, manifest, service worker). */
function listFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })
}

/**
 * Versions the service worker. After `vite build`, the `__CIVICAI_BUILD_ID__` token in dist/sw.js is
 * replaced by a hash of the emitted file names (which contain content hashes) and of the public files.
 * A new deployment therefore produces a byte-different sw.js, the browser installs it, and its activate
 * step deletes the previous version's shell cache. Identical builds keep the same id (no needless update).
 */
function serviceWorkerVersion() {
  let outDir = 'dist'
  let publicDir = ''
  let buildId = ''
  return {
    name: 'civicai-service-worker-version',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
      publicDir = config.publicDir
    },
    generateBundle(_options, bundle) {
      const hash = createHash('sha256')
      Object.keys(bundle)
        .sort()
        .forEach((fileName) => hash.update(fileName))
      listFiles(publicDir)
        .sort()
        .forEach((file) => hash.update(relative(publicDir, file)).update(readFileSync(file)))
      buildId = hash.digest('hex').slice(0, 12)
    },
    closeBundle() {
      const file = resolve(outDir, 'sw.js')
      if (!buildId || !existsSync(file)) return
      const source = readFileSync(file, 'utf8')
      if (source.includes(SW_BUILD_TOKEN)) writeFileSync(file, source.replaceAll(SW_BUILD_TOKEN, buildId))
    },
  }
}

/**
 * Vendor chunks by package. Only the listed packages go into each chunk; their shared dependencies (React's core,
 * react/jsx-runtime, commonjs helpers) stay where Rollup puts them. The object form of `manualChunks` pulled those
 * shared modules into whichever group listed them first - React ended up inside the `three` chunk, so every page
 * downloaded three.js at start-up. With this function the `three` chunk is reached only through the lazy 3D scenes.
 *
 * `use-sync-external-store` is shared by @react-three/fiber (through zustand) and recharts (through react-redux).
 * Left unlisted, Rollup placed it in `charts`, so the `three` chunk imported `charts` and every 3D page (login, the
 * landing, the dashboard) downloaded recharts too. It is a tiny React shim, so it joins the eager `react` group.
 */
const VENDOR_CHUNKS = [
  ['react', ['react/', 'react-dom/', 'react-router/', 'react-router-dom/', 'scheduler/', 'use-sync-external-store/']],
  ['vendor', ['axios/', 'date-fns/', 'clsx/', 'tailwind-merge/']],
  ['charts', ['recharts/']],
  ['maps', ['leaflet/', 'react-leaflet/', 'leaflet.markercluster/', '@react-leaflet/']],
  ['motion', ['framer-motion/', 'motion-dom/', 'motion-utils/']],
  ['three', ['three/', '@react-three/']],
]

function manualChunks(id) {
  const path = id.split('\\').join('/')
  const at = path.lastIndexOf('/node_modules/')
  // Stylesheets (main.jsx imports Leaflet's before index.css) belong to the main CSS bundle, not to a JS chunk:
  // grouped with `maps` they would make every page load the Leaflet code just for its CSS.
  if (at < 0 || /\.css($|\?)/.test(path)) return undefined
  const rest = path.slice(at + '/node_modules/'.length)
  const group = VENDOR_CHUNKS.find(([, prefixes]) => prefixes.some((prefix) => rest.startsWith(prefix)))
  return group?.[0]
}

/**
 * The dev and preview servers forward /api and /media to Django, so a build made with VITE_API_URL=/api runs on one
 * origin. share.ps1 serves such a build through a single ngrok link. `changeOrigin` stays off: Django sees the public
 * hostname and builds the photo URLs for it.
 */
const API_ORIGIN = process.env.CIVICAI_API_ORIGIN || 'http://127.0.0.1:8000'
const API_PROXY = { '/api': { target: API_ORIGIN }, '/media': { target: API_ORIGIN } }
// Vite answers only known hostnames; these are ngrok's public domains.
const TUNNEL_HOSTS = ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev', '.ngrok.io']

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorkerVersion()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: API_PROXY,
    allowedHosts: TUNNEL_HOSTS,
  },
  preview: {
    port: 4173,
    proxy: API_PROXY,
    allowedHosts: TUNNEL_HOSTS,
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Vendor code in separate, rarely-changing chunks: a redeploy of app code keeps them cached.
        manualChunks,
      },
    },
  },
})
