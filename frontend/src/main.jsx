/**
 * Browser entry point.
 *
 * CSS order matters: Leaflet's stylesheets are imported BEFORE index.css so CivicAI's map overrides
 * (theme-aware container background, popup colours, dark tiles) win the cascade even though map components
 * are lazy-loaded later.
 */
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/*
 * PWA: register the service worker in production builds only. In development it would cache Vite's dev
 * modules and fight hot reloading. `updateViaCache: 'none'` makes the browser always re-check /sw.js, so a
 * new deployment is picked up on the next visit.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch((error) => {
      console.warn('CivicAI: service worker registration failed', error)
    })
  })
}
