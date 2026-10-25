/**
 * HotspotAlertList - hotspot alerts raised by the DBSCAN scan, with acknowledge / reopen actions.
 *
 * An alert says "N complaints of one kind piled up within R metres of this place" (HotspotAlert). Active
 * (unacknowledged) alerts come first; acknowledged ones are hidden until "Show acknowledged" is switched on.
 *
 * Props:
 * - alerts: `[HotspotAlert]` `{id, area_name, latitude, longitude, radius_m, complaint_count,
 *   dominant_category: CategoryMini|null, severity, is_acknowledged, created_at}`
 * - loading, error, onRetry: list states
 * - onAcknowledge(alert, nextValue): must return the service promise; the row shows a spinner meanwhile
 *   (the page shows the toast and updates its data)
 * - mapHref(alert): link to the alert on the hotspot map (renders "Show on map" as a link)
 * - onLocate(alert): alternative to mapHref when the map is on the same page
 * - limit: show at most this many rows, with a "Show all" button for the rest
 * - emptyHint: extra sentence for the empty state (e.g. "Run checks now to scan again.")
 * - className
 *
 * Motion (answers the reviewer): the first alerts to load rise in one after another; alerts raised later (a
 * new scan) slide in at their place; an alert that leaves the list - acknowledged while acknowledged alerts are
 * hidden - folds away and the rows below close up. Reduced motion: rows simply appear and disappear.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { Check, MapPinned, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { CategoryBadge, SeverityBadge } from '@/components/complaints'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { DURATION, EASE, STAGGER } from '@/components/motion/tokens'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/utils/cn'
import { getLevelMeta } from '@/utils/constants'
import { formatDateTime, formatDistance, formatNumber, timeAgo } from '@/utils/format'

/**
 * `entrance`: null (no entrance), 'late' (arrived after the first load) or the row's index in the first batch.
 */
function AlertRow({ alert, entrance, reduced, pending, onToggle, mapHref, onLocate }) {
  const level = getLevelMeta(alert.severity)
  const acknowledged = Boolean(alert.is_acknowledged)
  const first = typeof entrance === 'number'
  return (
    <motion.li
      layout={reduced ? false : 'position'}
      initial={reduced || entrance == null ? false : { opacity: 0, y: first ? 10 : -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? undefined : { opacity: 0, height: 0, transition: { duration: DURATION.slow, ease: EASE.inOut } }}
      transition={{ duration: DURATION.slow, ease: EASE.enter, delay: first ? Math.min(entrance, STAGGER.max) * STAGGER.step : 0 }}
      className={cn('flex gap-3 overflow-hidden py-3 first:pt-0 last:pb-0', acknowledged && 'text-ink-2')}
    >
      <span
        aria-hidden
        className="w-1 shrink-0 self-stretch rounded-full"
        style={{ backgroundColor: acknowledged ? 'var(--c-line-strong)' : (level?.color ?? 'var(--c-line-strong)') }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="min-w-0 truncate font-semibold text-ink">{alert.area_name || 'Unnamed area'}</p>
          <time
            dateTime={alert.created_at}
            title={formatDateTime(alert.created_at)}
            className="shrink-0 text-xs text-ink-3 tabular"
          >
            {timeAgo(alert.created_at)}
          </time>
        </div>
        <p className="mt-0.5 text-xs text-ink-2">
          <span className="font-semibold text-ink tabular">{formatNumber(alert.complaint_count)}</span> complaints within{' '}
          <span className="tabular">{formatDistance(alert.radius_m)}</span>
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-2">
          <CategoryBadge category={alert.dominant_category} size="sm" />
          <SeverityBadge severity={alert.severity} size="sm" />
          {acknowledged ? (
            <Badge tone="neutral" size="sm" icon={Check}>
              Acknowledged
            </Badge>
          ) : null}
          <span className="ml-auto flex items-center gap-1">
            {acknowledged ? (
              <Button variant="ghost" size="sm" leftIcon={RotateCcw} loading={pending} onClick={() => onToggle(alert, false)}>
                Reopen
              </Button>
            ) : (
              <Button variant="outline" size="sm" leftIcon={Check} loading={pending} onClick={() => onToggle(alert, true)}>
                Acknowledge
              </Button>
            )}
            {mapHref ? (
              <IconButton
                icon={MapPinned}
                label={`Show ${alert.area_name || 'this alert'} on the map`}
                size="sm"
                to={mapHref(alert)}
              />
            ) : onLocate ? (
              <IconButton
                icon={MapPinned}
                label={`Show ${alert.area_name || 'this alert'} on the map`}
                size="sm"
                onClick={() => onLocate(alert)}
              />
            ) : null}
          </span>
        </div>
      </div>
    </motion.li>
  )
}

export function HotspotAlertList({
  alerts,
  loading = false,
  error,
  onRetry,
  onAcknowledge,
  mapHref,
  onLocate,
  limit,
  emptyHint,
  className,
}) {
  const [showAcknowledged, setShowAcknowledged] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [pendingId, setPendingId] = useState(null)
  const reduced = usePrefersReducedMotion()
  // Ids of the alerts in the first list shown: they play the cascading entrance; later arrivals slide in.
  const [firstIds, setFirstIds] = useState(null)
  const list = Array.isArray(alerts) ? alerts : []
  const active = list.filter((alert) => !alert.is_acknowledged)
  const acknowledgedCount = list.length - active.length
  const shown = showAcknowledged ? [...active, ...list.filter((alert) => alert.is_acknowledged)] : active
  const visible = limit && !expanded ? shown.slice(0, limit) : shown
  if (firstIds === null && visible.length) setFirstIds(new Set(visible.map((alert) => alert.id)))
  const entranceOf = (alert, index) => {
    if (!firstIds) return index
    return firstIds.has(alert.id) ? (index < STAGGER.max ? index : null) : 'late'
  }

  const toggle = async (alert, value) => {
    setPendingId(alert.id)
    try {
      await onAcknowledge?.(alert, value)
    } catch {
      // The page reports the failure (toast); the row simply stops spinning.
    } finally {
      setPendingId(null)
    }
  }

  if (error && !list.length) {
    return <ErrorState compact bordered={false} error={error} onRetry={onRetry} title="Alerts could not load" />
  }

  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-ink-2" aria-live="polite">
          {loading && !list.length ? (
            <Skeleton className="h-4 w-24" />
          ) : (
            <>
              <span className="font-semibold text-ink tabular">{formatNumber(active.length)}</span> active
              {acknowledgedCount ? (
                <span className="text-ink-3">
                  , <span className="tabular">{formatNumber(acknowledgedCount)}</span> acknowledged
                </span>
              ) : null}
            </>
          )}
        </div>
        {acknowledgedCount ? (
          <Switch
            label="Show acknowledged"
            checked={showAcknowledged}
            onCheckedChange={(checked) => {
              setShowAcknowledged(checked)
              // The acknowledged alerts come after the active ones, so reveal the whole list.
              if (checked) setExpanded(true)
            }}
            className="shrink-0"
          />
        ) : null}
      </div>

      {loading && !list.length ? (
        <ul aria-hidden className="space-y-4">
          {[0, 1, 2].map((index) => (
            <li key={index} className="flex gap-3">
              <Skeleton className="h-16 w-1" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-5 w-2/3" />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        // The list and the empty state take turns: when the last alert leaves, the list folds away first.
        <AnimatePresence mode="wait" initial={false}>
          {visible.length ? (
            <motion.ul
              key="alerts"
              className="divide-y divide-line"
              exit={reduced ? undefined : { opacity: 0, height: 0, transition: { duration: DURATION.slow, ease: EASE.inOut } }}
            >
              <AnimatePresence>
                {visible.map((alert, index) => (
                  <AlertRow
                    key={alert.id}
                    entrance={entranceOf(alert, index)}
                    reduced={reduced}
                    alert={alert}
                    pending={pendingId === alert.id}
                    onToggle={toggle}
                    mapHref={mapHref}
                    onLocate={onLocate}
                  />
                ))}
              </AnimatePresence>
            </motion.ul>
          ) : (
            <motion.div
              key="empty"
              initial={reduced ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: DURATION.slow, ease: EASE.enter }}
            >
              <EmptyState
                compact
                bordered={false}
                icon={Check}
                title={list.length ? 'Every alert is acknowledged' : 'No hotspot alerts'}
                description={
                  <>
                    {list.length
                      ? 'New clusters of complaints will raise fresh alerts.'
                      : 'Alerts appear when the hotspot scan finds complaints piling up in one place.'}
                    {emptyHint ? ` ${emptyHint}` : ''}
                  </>
                }
              />
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {limit && shown.length > limit ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-3 rounded-md text-sm font-semibold text-primary-ink hover:underline pointer-coarse:min-h-11"
        >
          {expanded ? 'Show fewer' : `Show all ${formatNumber(shown.length)} alerts`}
        </button>
      ) : null}
    </div>
  )
}

export default HotspotAlertList
