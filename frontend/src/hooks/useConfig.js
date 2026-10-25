/**
 * System configuration: `{ config, loading, loaded, error, isDemo, modelMode, mapCenter [lat, lng], mapZoom,
 * city, upload, maxImageMB, reopenWindowDays, reload() }`. Safe defaults are returned while loading or offline.
 */
import { useContext } from 'react'
import { ConfigContext } from '@/context/contexts'

export function useConfig() {
  const context = useContext(ConfigContext)
  if (!context) throw new Error('useConfig() must be used inside <ConfigProvider>.')
  return context
}

export default useConfig
