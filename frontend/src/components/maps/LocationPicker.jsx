/**
 * LocationPicker - choose where the issue is: search a place, use GPS, click the map or drag the pin.
 *
 * Props:
 * - value: `{lat, lng}` | null
 * - onChange({lat, lng}): every new pin position (rounded to 6 decimals, the backend's Decimal(9, 6))
 * - onAddress({address, area, city, pincode, display_name, source}): the address of the pin, from the
 *   chosen search result or from reverse geocoding (GET /geo/reverse/, a Nominatim proxy on our backend)
 * - height: map height in px (default 320)
 * - label: accessible name of the control group (default "Issue location")
 * - disabled: read-only map
 * - error: validation message shown under the map (e.g. "Choose the location on the map")
 * - reverseGeocode: look up the address after clicks / drags / GPS fixes (default true)
 * - searchPlaceholder
 * - className
 *
 * Techniques:
 * - Place search is a WAI-ARIA combobox: input debounced by 400 ms (useDebounce), at least 3 characters,
 *   each request cancellable with an AbortController so an old, slow answer never replaces a newer one;
 *   arrow keys move through the results, Enter picks (and never submits the surrounding form), Esc closes.
 * - Reverse geocoding is debounced (450 ms) and numbered: only the latest request may update the address,
 *   so dragging the pin quickly costs one lookup and stale answers are dropped.
 * - "Use my location" uses useGeolocation (high accuracy with a low-accuracy retry) and draws the reported
 *   accuracy as a circle; the map flies to the fix (or jumps there when the user prefers reduced motion).
 * - Keyboard users can pan the map with the arrow keys and press "Pin map centre" to place the pin.
 * Search UI and buttons sit outside the Leaflet container, so typing or tapping them never moves the pin.
 */
import { useReducedMotion } from 'framer-motion'
import { Crosshair, LocateFixed, MapPin, Search, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Circle, Marker, useMap, useMapEvents } from 'react-leaflet'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FIELD_BASE, FIELD_INVALID } from '@/components/ui/fieldStyles'
import { Spinner } from '@/components/ui/Spinner'
import { useDebounce } from '@/hooks/useDebounce'
import { useGeolocation } from '@/hooks/useGeolocation'
import { systemService } from '@/services/systemService'
import { cn } from '@/utils/cn'
import { getErrorMessage, isCancelError } from '@/utils/errors'
import { BaseMap } from './BaseMap'
import { isValidLatLng, round6 } from './leaflet'
import { complaintPinIcon } from './mapIcons'

const PICKER_COLOR = '#0b6e4f'
const ACCURACY_STYLE = { color: '#1f5fad', weight: 1, opacity: 0.6, fillColor: '#1f5fad', fillOpacity: 0.08 }
const MIN_QUERY = 3
/** The first pin placed by hand at city zoom (below this level) zooms the map in on it... */
const PRECISE_ZOOM_BELOW = 15
/** ...to street level, where dragging the pin onto the exact spot is easy, also with a finger. */
const FIRST_PIN_ZOOM = 16

/** The address fields the complaint form needs, from a geocoding answer. */
function toAddress(result) {
  const source = result && typeof result === 'object' ? result : {}
  return {
    address: source.address ?? '',
    area: source.area ?? '',
    city: source.city ?? '',
    pincode: source.pincode ?? '',
    display_name: source.display_name ?? source.address ?? '',
    source: source.source ?? 'search',
  }
}

function splitDisplayName(name) {
  const parts = String(name ?? '').split(',').map((part) => part.trim()).filter(Boolean)
  return { primary: parts[0] ?? '', secondary: parts.slice(1, 4).join(', ') }
}

function PlaceSearch({ onPick, placeholder, disabled }) {
  const listId = useId()
  const [query, setQuery] = useState('')
  const term = useDebounce(query.trim(), 400)
  const [result, setResult] = useState({ term: '', status: 'idle', places: [], message: '' })
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)

  useEffect(() => {
    if (term.length < MIN_QUERY) return undefined
    const controller = new AbortController()
    setResult((current) => ({ ...current, term, status: 'loading' }))
    systemService
      .searchPlaces(term, { signal: controller.signal })
      .then((places) => {
        setResult({ term, status: 'done', places: Array.isArray(places) ? places.slice(0, 8) : [], message: '' })
        setActiveIndex(-1)
      })
      .catch((error) => {
        if (isCancelError(error)) return
        setResult({ term, status: 'error', places: [], message: getErrorMessage(error, 'Place search is not available right now.') })
      })
    return () => controller.abort()
  }, [term])

  const typed = query.trim()
  const searching = typed.length >= MIN_QUERY && (typed !== term || result.term !== term || result.status === 'loading')
  const current = typed.length >= MIN_QUERY && result.term === term && typed === term ? result : null
  const places = current?.status === 'done' ? current.places : []
  const expanded = open && typed.length >= MIN_QUERY && (searching || Boolean(current))

  const pick = (place) => {
    if (!place) return
    onPick(place)
    setQuery('')
    setOpen(false)
    setActiveIndex(-1)
  }

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((index) => (places.length ? (index + 1) % places.length : -1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (places.length ? (index <= 0 ? places.length - 1 : index - 1) : -1))
    } else if (event.key === 'Enter') {
      event.preventDefault() // never submit the surrounding complaint form from the search box
      if (expanded && places[activeIndex]) pick(places[activeIndex])
      else if (expanded && places.length === 1) pick(places[0])
      else setOpen(true)
    } else if (event.key === 'Escape' && open) {
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
      <input
        type="search"
        role="combobox"
        aria-label="Search for a place"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && places[activeIndex] ? `${listId}-option-${activeIndex}` : undefined}
        autoComplete="off"
        enterKeyHint="search"
        disabled={disabled}
        value={query}
        placeholder={placeholder}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        className={cn(FIELD_BASE, 'h-10 pl-9 pr-9 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:appearance-none')}
      />
      {searching ? (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3">
          <Spinner size="sm" label="Searching places" />
        </span>
      ) : null}
      {expanded ? (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow-overlay)]">
          <ul id={listId} role="listbox" aria-label="Places" className="scrollbar-thin max-h-64 overflow-y-auto py-1">
            {places.map((place, index) => {
              const { primary, secondary } = splitDisplayName(place.display_name || place.address)
              return (
                <li
                  key={`${place.latitude},${place.longitude},${index}`}
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(place)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 px-3 py-2 text-sm pointer-coarse:py-3',
                    index === activeIndex ? 'bg-primary-soft' : 'hover:bg-surface-2',
                  )}
                >
                  <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-ink">{primary || place.city}</span>
                    {secondary ? <span className="block truncate text-xs text-ink-3">{secondary}</span> : null}
                  </span>
                </li>
              )
            })}
          </ul>
          {searching && !places.length ? <p className="px-3 py-2.5 text-sm text-ink-3">Searching…</p> : null}
          {current?.status === 'done' && !places.length ? (
            <p className="px-3 py-2.5 text-sm text-ink-2">No places found for “{current.term}”. Try a landmark or an area name.</p>
          ) : null}
          {current?.status === 'error' ? (
            <p className="flex items-start gap-1.5 px-3 py-2.5 text-sm text-hazard-700 dark:text-hazard-300">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {current.message} You can still click the map to place the pin.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Inside the map: click to place, the draggable pin, the GPS accuracy circle and view updates. */
function MapInteractions({ position, disabled, accuracy, viewRequestRef, onPick }) {
  const map = useMap()
  const reducedMotion = useReducedMotion()
  useMapEvents({
    click(event) {
      if (!disabled) onPick(event.latlng)
    },
  })

  const lat = position?.lat
  const lng = position?.lng
  useEffect(() => {
    if (lat == null || lng == null) return
    const requestedZoom = viewRequestRef.current
    viewRequestRef.current = null
    if (requestedZoom) {
      const zoom = Math.max(requestedZoom, map.getZoom())
      if (reducedMotion) map.setView([lat, lng], zoom)
      else map.flyTo([lat, lng], zoom, { duration: 0.8 })
    } else if (!map.getBounds().pad(-0.05).contains([lat, lng])) {
      map.setView([lat, lng], Math.max(map.getZoom(), 15))
    }
  }, [map, lat, lng, viewRequestRef, reducedMotion])

  const markerPosition = useMemo(() => (lat == null || lng == null ? null : [lat, lng]), [lat, lng])
  const markerHandlers = useMemo(() => ({ dragend: (event) => onPick(event.target.getLatLng()) }), [onPick])
  const accuracyCenter = useMemo(() => (accuracy ? [accuracy.lat, accuracy.lng] : null), [accuracy])

  return (
    <>
      {accuracyCenter && accuracy.accuracy > 0 ? (
        <Circle center={accuracyCenter} radius={accuracy.accuracy} pathOptions={ACCURACY_STYLE} interactive={false} />
      ) : null}
      {markerPosition ? (
        <Marker
          position={markerPosition}
          icon={complaintPinIcon({ color: PICKER_COLOR, size: 'lg' })}
          draggable={!disabled}
          keyboard={false}
          autoPan
          title={disabled ? 'Issue location' : 'Drag to adjust the location'}
          eventHandlers={markerHandlers}
        />
      ) : null}
    </>
  )
}

export function LocationPicker({
  value,
  onChange,
  onAddress,
  height = 320,
  label = 'Issue location',
  disabled = false,
  error,
  reverseGeocode = true,
  searchPlaceholder = 'Search for a street, area or landmark',
  className,
}) {
  const geo = useGeolocation()
  const geoRef = useRef(geo)
  const mapRef = useRef(null)
  const viewRequestRef = useRef(null)
  const lookupTimerRef = useRef(0)
  const lookupIdRef = useRef(0)
  const onChangeRef = useRef(onChange)
  const onAddressRef = useRef(onAddress)
  const [accuracy, setAccuracy] = useState(null)
  const [lookup, setLookup] = useState({ status: 'idle', text: '' })

  useEffect(() => {
    onChangeRef.current = onChange
    onAddressRef.current = onAddress
    geoRef.current = geo
  })
  useEffect(() => () => window.clearTimeout(lookupTimerRef.current), [])

  const position = value && isValidLatLng(value.lat, value.lng) ? { lat: Number(value.lat), lng: Number(value.lng) } : null
  const [initialView] = useState(() => (position ? { center: [position.lat, position.lng], zoom: 16 } : null))

  const resolveAddress = useCallback(
    (lat, lng) => {
      window.clearTimeout(lookupTimerRef.current)
      if (!reverseGeocode) return
      lookupIdRef.current += 1
      const requestId = lookupIdRef.current
      setLookup({ status: 'loading', text: '' })
      lookupTimerRef.current = window.setTimeout(async () => {
        try {
          const result = await systemService.reverseGeocode(lat, lng)
          if (requestId !== lookupIdRef.current) return
          const address = toAddress({ ...result, source: result?.source ?? 'fallback' })
          setLookup({ status: address.display_name ? 'done' : 'empty', text: address.display_name })
          onAddressRef.current?.(address)
        } catch (lookupError) {
          if (requestId !== lookupIdRef.current) return
          setLookup({ status: 'error', text: getErrorMessage(lookupError, "The address lookup didn't answer.") })
        }
      }, 450)
    },
    [reverseGeocode],
  )

  /** Place the pin. `fly` = zoom level to fly to; `address` = known address (search result, no lookup). */
  const placePin = useCallback(
    (latlng, { fly = null, address = null, keepAccuracy = false } = {}) => {
      if (disabled || !isValidLatLng(latlng?.lat, latlng?.lng)) return
      const next = { lat: round6(latlng.lat), lng: round6(latlng.lng) }
      if (fly) viewRequestRef.current = fly
      if (!keepAccuracy) {
        setAccuracy(null)
        if (geoRef.current.error) geoRef.current.clear() // a manual placement answers the location problem
      }
      onChangeRef.current?.(next)
      if (address) {
        window.clearTimeout(lookupTimerRef.current)
        lookupIdRef.current += 1
        setLookup({ status: 'done', text: address.display_name })
        onAddressRef.current?.(address)
      } else {
        resolveAddress(next.lat, next.lng)
      }
    },
    [disabled, resolveAddress],
  )

  // A pin placed by hand (map click / tap, "Pin map centre") while there is none yet and the map still shows the
  // whole city: zoom in on it, so the next drag can be precise. Later placements keep the user's zoom.
  const hasPin = Boolean(position)
  const firstPinZoom = useCallback(() => {
    const map = mapRef.current
    return !hasPin && map && map.getZoom() < PRECISE_ZOOM_BELOW ? FIRST_PIN_ZOOM : null
  }, [hasPin])
  const handleMapPick = useCallback((latlng) => placePin(latlng, { fly: firstPinZoom() }), [placePin, firstPinZoom])

  const locate = async () => {
    const fix = await geo.locate()
    if (!fix) return
    setAccuracy(fix)
    placePin(fix, { fly: 17, keepAccuracy: true })
  }

  const pinCentre = () => {
    const map = mapRef.current
    if (map) placePin(map.getCenter(), { fly: firstPinZoom() })
  }

  const pickPlace = (place) => {
    placePin({ lat: Number(place.latitude), lng: Number(place.longitude) }, { fly: 17, address: toAddress(place) })
  }

  return (
    <div role="group" aria-label={label} className={cn('@container min-w-0 space-y-2', className)}>
      <PlaceSearch onPick={pickPlace} placeholder={searchPlaceholder} disabled={disabled} />

      <BaseMap
        height={height}
        center={initialView?.center}
        zoom={initialView?.zoom}
        mapRef={mapRef}
        label={`${label} map. Click the map to place the pin.`}
        className={cn(error && FIELD_INVALID)}
      >
        <MapInteractions
          position={position}
          disabled={disabled}
          accuracy={accuracy}
          viewRequestRef={viewRequestRef}
          onPick={handleMapPick}
        />
      </BaseMap>

      <div className="flex flex-col gap-2 @lg:flex-row @lg:items-start @lg:justify-between">
        <div className="min-w-0 flex-1 space-y-0.5 text-xs" aria-live="polite">
          {position ? (
            <p className="flex items-center gap-1.5 font-semibold text-ink-2 tabular">
              <MapPin aria-hidden className="size-3.5 shrink-0 text-primary-ink" />
              {position.lat.toFixed(6)}, {position.lng.toFixed(6)}
              {accuracy?.accuracy ? <span className="font-normal text-ink-3">(GPS accuracy about {accuracy.accuracy} m)</span> : null}
            </p>
          ) : (
            <p className="text-ink-3">Click the map, search for a place, or use your location to place the pin.</p>
          )}
          {lookup.status === 'loading' ? (
            <p className="flex items-center gap-1.5 text-ink-3">
              <Spinner size="xs" decorative />
              Finding the address…
            </p>
          ) : null}
          {lookup.status === 'done' ? <p className="text-ink">{lookup.text}</p> : null}
          {lookup.status === 'empty' ? <p className="text-ink-3">No street address is known for this spot. You can type it in.</p> : null}
          {lookup.status === 'error' ? (
            <p className="text-hazard-700 dark:text-hazard-300">{lookup.text} You can type the address in yourself.</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="ghost" size="sm" leftIcon={Crosshair} onClick={pinCentre} disabled={disabled}>
            Pin map centre
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={LocateFixed}
            loading={geo.loading}
            onClick={locate}
            disabled={disabled || !geo.supported}
          >
            Use my location
          </Button>
        </div>
      </div>

      {geo.error ? (
        <Alert tone="warning" title="Location not available">
          {geo.error.message}
        </Alert>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-xs font-medium text-signal-600 dark:text-signal-300">
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  )
}

export default LocationPicker
