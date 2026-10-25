/**
 * System configuration provider (GET /api/system/config/, public).
 *
 * Loaded once per page load and shared by every screen: AI mode (drives the "Demo AI Mode" badge), the
 * default map centre / zoom, upload limits and the citizen reopen window. Until the request answers - or if
 * the API is offline - safe defaults are used (Hyderabad map centre, 8 MB uploads), and `isDemo` stays false
 * because the mode is not known yet. When the first load failed, it is retried as soon as the browser reports
 * that it is back online.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfigContext } from '@/context/contexts'
import { systemService } from '@/services/systemService'
import { DEFAULT_SYSTEM_CONFIG } from '@/utils/constants'

/** One shared request: React StrictMode mounts effects twice in development. */
let pendingConfig = null

function fetchConfig({ force = false } = {}) {
  if (force || !pendingConfig) {
    pendingConfig = systemService.config().catch((error) => {
      pendingConfig = null
      throw error
    })
  }
  return pendingConfig
}

/** Shallow-merge the server config over the defaults, keeping nested defaults for missing keys. */
function mergeConfig(data) {
  const source = data && typeof data === 'object' ? data : {}
  return {
    ...DEFAULT_SYSTEM_CONFIG,
    ...source,
    map: { ...DEFAULT_SYSTEM_CONFIG.map, ...(source.map ?? {}) },
    upload: { ...DEFAULT_SYSTEM_CONFIG.upload, ...(source.upload ?? {}) },
    statuses: Array.isArray(source.statuses) && source.statuses.length ? source.statuses : DEFAULT_SYSTEM_CONFIG.statuses,
    levels: Array.isArray(source.levels) && source.levels.length ? source.levels : DEFAULT_SYSTEM_CONFIG.levels,
  }
}

function toCenter(center) {
  if (Array.isArray(center) && center.length === 2) {
    const [lat, lng] = center.map(Number)
    if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng]
  }
  return DEFAULT_SYSTEM_CONFIG.map.center
}

export function ConfigProvider({ children }) {
  const [state, setState] = useState({ config: DEFAULT_SYSTEM_CONFIG, loading: true, loaded: false, error: null })

  const load = useCallback(async ({ force = false } = {}) => {
    setState((current) => ({ ...current, loading: true }))
    try {
      const data = await fetchConfig({ force })
      setState({ config: mergeConfig(data), loading: false, loaded: true, error: null })
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error }))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (state.loaded) return undefined
    const handleOnline = () => load({ force: true })
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [state.loaded, load])

  const reload = useCallback(() => load({ force: true }), [load])

  const value = useMemo(() => {
    const { config } = state
    const modeKnown = state.loaded && (config.is_demo != null || config.model_mode != null)
    return {
      config,
      loading: state.loading,
      loaded: state.loaded,
      error: state.error,
      isDemo: modeKnown ? Boolean(config.is_demo ?? config.model_mode !== 'production') : false,
      modelMode: config.model_mode,
      mapCenter: toCenter(config.map?.center),
      mapZoom: Number(config.map?.zoom) || DEFAULT_SYSTEM_CONFIG.map.zoom,
      city: config.map?.city || DEFAULT_SYSTEM_CONFIG.map.city,
      upload: config.upload,
      maxImageMB: Number(config.upload?.max_image_mb) || DEFAULT_SYSTEM_CONFIG.upload.max_image_mb,
      reopenWindowDays: Number(config.reopen_window_days) || DEFAULT_SYSTEM_CONFIG.reopen_window_days,
      reload,
    }
  }, [state, reload])

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>
}

export default ConfigProvider
