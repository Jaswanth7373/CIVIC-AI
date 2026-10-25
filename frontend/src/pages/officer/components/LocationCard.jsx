/**
 * LocationCard - where the crew has to go: a static map, the address as the citizen gave it, the GPS
 * coordinates and turn-by-turn directions in OpenStreetMap or Google Maps (both open the navigation app on a
 * phone). "Copy" puts the coordinates on the clipboard for a radio message or another navigation app.
 *
 * Props:
 * - location: LocationOut `{latitude, longitude, address, landmark, area, city, pincode}`
 * - color: pin colour (the category colour)
 * - className
 *
 * After a successful copy the button shows a tick for a moment (and says "Coordinates copied"), so the officer
 * sees the copy worked without reading the toast.
 */
import { Check, Copy, MapPin, Navigation } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MiniMap } from '@/components/maps/MiniMap'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { IconButton } from '@/components/ui/IconButton'
import { useToast } from '@/hooks/useToast'
import { formatNumber } from '@/utils/format'
import { directionsLinks } from './officerUtils'

const coordinate = (value) => formatNumber(value, { digits: 6 })

export function LocationCard({ location, color, className }) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const lat = location?.latitude
  const lng = location?.longitude
  const links = directionsLinks(lat, lng)
  const cityLine = [location?.area, location?.city, location?.pincode].filter(Boolean).join(', ')

  const copyCoordinates = async () => {
    const text = `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      toast.success('Coordinates copied', text)
    } catch {
      toast.error('Could not copy the coordinates', `Your browser blocked the clipboard. The coordinates are ${text}.`)
    }
  }

  // The tick stays for a moment, then the copy icon comes back.
  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <Card className={className}>
      <CardHeader title="Location" icon={MapPin} />
      <CardBody className="space-y-4">
        <MiniMap lat={lat} lng={lng} color={color} height={190} showLinks={false} label="Map of the complaint location" />
        <div className="space-y-1">
          {location?.address ? <p className="font-semibold text-ink">{location.address}</p> : null}
          {location?.landmark ? <p className="text-sm text-ink-2">Landmark: {location.landmark}</p> : null}
          {cityLine ? <p className="text-sm text-ink-2">{cityLine}</p> : null}
          {links ? (
            <div className="flex items-center justify-between gap-2 pt-1">
              <p className="text-xs text-ink-3">
                GPS{' '}
                <span className="font-semibold text-ink-2 tabular">
                  {coordinate(lat)}, {coordinate(lng)}
                </span>
              </p>
              <IconButton
                icon={copied ? Check : Copy}
                label={copied ? 'Coordinates copied' : 'Copy coordinates'}
                size="sm"
                onClick={copyCoordinates}
                className={copied ? 'text-sign-600 hover:text-sign-700 dark:text-sign-300' : undefined}
              />
            </div>
          ) : null}
        </div>
        {links ? (
          <div>
            <p className="mb-2 text-xs font-semibold text-ink-2">Get directions</p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" leftIcon={Navigation} href={links.osm} target="_blank" rel="noopener noreferrer">
                OpenStreetMap
                <span className="sr-only"> directions (opens in a new tab)</span>
              </Button>
              <Button variant="outline" size="sm" leftIcon={Navigation} href={links.google} target="_blank" rel="noopener noreferrer">
                Google Maps
                <span className="sr-only"> directions (opens in a new tab)</span>
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-3">The citizen did not share a GPS position, so directions are not available.</p>
        )}
      </CardBody>
    </Card>
  )
}

export default LocationCard
