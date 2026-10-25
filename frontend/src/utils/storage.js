/**
 * Safe wrapper around `window.localStorage`.
 *
 * localStorage can throw (Safari private mode, storage disabled by browser policy, quota exceeded) or be
 * missing entirely (non-browser tooling). Every access therefore goes through try/catch and falls back to an
 * in-memory Map, so the app keeps working for the current tab even when persistence is unavailable.
 *
 * Values are stored as plain strings (`get` / `set`). `getJSON` / `setJSON` add JSON (de)serialisation for
 * structured values. Theme and token keys are deliberately stored as raw strings because the inline script in
 * index.html reads `civicai.theme` before React loads.
 */

/** Every localStorage key used by the frontend, in one place. */
export const STORAGE_KEYS = Object.freeze({
  accessToken: 'civicai.access',
  refreshToken: 'civicai.refresh',
  theme: 'civicai.theme',
  sidebar: 'civicai.sidebar',
})

const memory = new Map()
let cachedBackend

/** Returns localStorage when it is usable, otherwise null (probe write, evaluated once). */
function getBackend() {
  if (cachedBackend !== undefined) return cachedBackend
  try {
    const probe = '__civicai_probe__'
    window.localStorage.setItem(probe, probe)
    window.localStorage.removeItem(probe)
    cachedBackend = window.localStorage
  } catch {
    cachedBackend = null
  }
  return cachedBackend
}

export const storage = {
  /** Read a raw string value; returns `fallback` when the key is absent or storage is unreadable. */
  get(key, fallback = null) {
    const backend = getBackend()
    try {
      const value = backend ? backend.getItem(key) : memory.get(key)
      return value ?? fallback
    } catch {
      return memory.get(key) ?? fallback
    }
  },

  /** Store a value as a string. A failed write (quota, policy) keeps the value in memory for this tab. */
  set(key, value) {
    const text = String(value)
    const backend = getBackend()
    try {
      if (backend) backend.setItem(key, text)
      else memory.set(key, text)
    } catch {
      memory.set(key, text)
    }
  },

  remove(key) {
    memory.delete(key)
    const backend = getBackend()
    try {
      backend?.removeItem(key)
    } catch {
      // Nothing else to clean up: the in-memory copy is already gone.
    }
  },

  /** Read and JSON-parse a value; malformed JSON returns `fallback` instead of throwing. */
  getJSON(key, fallback = null) {
    const raw = this.get(key)
    if (raw == null) return fallback
    try {
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  },

  setJSON(key, value) {
    this.set(key, JSON.stringify(value))
  },

  /** True when values survive a reload (real localStorage), false when only the memory fallback works. */
  isPersistent() {
    return getBackend() !== null
  },
}

export default storage
