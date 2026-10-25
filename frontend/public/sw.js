/*
 * CivicAI service worker - installable PWA with an offline-capable app shell.
 *
 * Caching strategy (only same-origin GET requests are ever touched):
 * - Navigations (HTML page loads): NETWORK FIRST. A successful response refreshes the cached copy of
 *   index.html; when the network fails (offline), the cached index.html is served so the app shell still
 *   opens, and a small offline page is shown if nothing is cached yet.
 * - /assets/* (Vite output with content hashes in the file names): CACHE FIRST. A hashed file never changes,
 *   so a cached copy is always correct; new builds use new names. The cache is trimmed to the newest entries.
 * - Shell files (manifest, favicon, icons): stale-while-revalidate.
 * - NEVER cached: /api/* and /media/* (live data and uploads must always come from the server) and every
 *   cross-origin request (the API host, map tiles, web fonts) - the browser handles those normally.
 *
 * Robustness: Cache Storage can fail (storage quota, private browsing, a corrupted profile). Every cache
 * operation is guarded and degrades to a plain network request, so the worker can never break the app; cache
 * writes run in the background (event.waitUntil) and never delay a response.
 *
 * Versioning: BUILD_ID is stamped at build time by vite.config.js, so each deployment ships a different
 * sw.js. The new worker calls skipWaiting() + clients.claim() to take over immediately, and its activate
 * step deletes caches of older versions.
 */
const BUILD_ID = '__CIVICAI_BUILD_ID__'
const CACHE_PREFIX = 'civicai-'
const SHELL_CACHE = `${CACHE_PREFIX}shell-${BUILD_ID}`
const ASSET_CACHE = `${CACHE_PREFIX}assets-v1`
const MAX_ASSET_ENTRIES = 160

const SHELL_URLS = ['/index.html', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png']
const SHELL_PATHS = new Set(SHELL_URLS.filter((url) => url !== '/index.html'))
const NEVER_CACHE = [/^\/api\//, /^\/media\//]

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline | CivicAI</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef1f0;color:#142022;font-family:system-ui,sans-serif}
main{max-width:28rem;padding:24px;text-align:center}h1{font-size:1.4rem;margin:0 0 8px}p{color:#45555a;line-height:1.5}
@media (prefers-color-scheme:dark){body{background:#0f1617;color:#e6ecea}p{color:#a7b4b1}}</style></head>
<body><main><h1>You're offline</h1><p>CivicAI needs an internet connection the first time it opens. Connect to the internet and reload the page.</p></main></body></html>`

/** caches.open that never throws (null when Cache Storage is unavailable). */
async function openCache(name) {
  try {
    return await caches.open(name)
  } catch {
    return null
  }
}

/** cache.match that never throws. */
async function matchIn(cache, request) {
  if (!cache) return undefined
  try {
    return await cache.match(request)
  } catch {
    return undefined
  }
}

/** Store a response copy; failures (quota, storage errors) are ignored - caching is an optimisation. */
async function putIn(cacheName, request, response, maxEntries = 0) {
  const cache = await openCache(cacheName)
  if (!cache) return
  try {
    await cache.put(request, response)
    if (maxEntries) await trimCache(cache, maxEntries)
  } catch {
    // Ignored on purpose: the network response was already returned to the page.
  }
}

/** Delete the oldest entries (Cache Storage keeps insertion order) beyond `max`. */
async function trimCache(cache, max) {
  const keys = await cache.keys()
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((request) => cache.delete(request)))
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await openCache(SHELL_CACHE)
      if (cache) {
        // Fetch each shell file individually (bypassing the HTTP cache): one missing file must not abort install.
        await Promise.allSettled(
          SHELL_URLS.map(async (url) => {
            const response = await fetch(new Request(url, { cache: 'reload' }))
            if (response.ok) await cache.put(url, response)
          }),
        )
      }
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keep = new Set([SHELL_CACHE, ASSET_CACHE])
        const names = await caches.keys()
        await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && !keep.has(name)).map((name) => caches.delete(name)))
      } catch {
        // Cache Storage unavailable: nothing to clean up.
      }
      await self.clients.claim()
    })(),
  )
})

async function networkFirstNavigation(event) {
  const { request } = event
  try {
    const response = await fetch(request)
    const type = response.headers.get('content-type') || ''
    if (response.ok && type.includes('text/html')) event.waitUntil(putIn(SHELL_CACHE, '/index.html', response.clone()))
    return response
  } catch {
    const cached = (await matchIn(await openCache(SHELL_CACHE), '/index.html')) || (await caches.match('/index.html').catch(() => undefined))
    if (cached) return cached
    return new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
}

async function cacheFirstAsset(event) {
  const { request } = event
  const cached = await matchIn(await openCache(ASSET_CACHE), request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok && response.type === 'basic') event.waitUntil(putIn(ASSET_CACHE, request, response.clone(), MAX_ASSET_ENTRIES))
  return response
}

async function staleWhileRevalidate(event) {
  const { request } = event
  const cached = await matchIn(await openCache(SHELL_CACHE), request)
  const network = fetch(request)
    .then((response) => {
      if (response.ok && response.type === 'basic') event.waitUntil(putIn(SHELL_CACHE, request, response.clone()))
      return response
    })
    .catch(() => null)
  if (cached) {
    event.waitUntil(network)
    return cached
  }
  const response = await network
  return response || new Response('', { status: 504, statusText: 'Offline' })
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (NEVER_CACHE.some((pattern) => pattern.test(url.pathname))) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event))
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(event))
  } else if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event))
  }
})
