/**
 * CityPulse3D - the admin dashboard's "City pulse": the real hotspot clusters (GET /api/analytics/hotspots/
 * `clusters`) as hexagonal columns on a stylised district plane, with an HTML caption and an accessible list of the
 * same data. Nothing is invented: the columns, labels and numbers all come from the clusters passed in.
 *
 * <CityPulse3D clusters={hotspots.data?.clusters} onSelect={(cluster) => navigate(...)} />
 *
 * - 3D (lazy, SceneCanvas): column height proportional to the complaint count, colour = the cluster's severity level
 *   (LEVEL_META), the three largest labelled with their area name; slow orbit; pointer hover highlights a column.
 * - The list (largest first) mirrors the scene: hovering or focusing a row highlights its column and the caption;
 *   with `onSelect`, rows are buttons that pass the original cluster object back.
 * - No WebGL / low tier: an SVG still of the same columns. No clusters: an empty state. `loading`: a skeleton.
 *
 * Props: clusters, onSelect?, loading?, className, emptyTitle?, emptyDescription?
 */
import { useContext, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { ThemeContext } from '@/context/contexts'
import { cn } from '@/utils/cn'
import { LEVEL_META } from '@/utils/constants'
import { PulseScene } from './lazyScenes'
import { PulseStill } from './pulse/PulseStill'
import { prepareClusters } from './pulse/prepare'
import { SceneCanvas } from './SceneCanvas'

const numberFormat = new Intl.NumberFormat('en-IN')
const complaints = (count) => `${numberFormat.format(count)} ${count === 1 ? 'complaint' : 'complaints'}`

function resolveTheme(context) {
  if (context?.resolvedTheme) return context.resolvedTheme
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) return 'dark'
  return 'light'
}

function SeverityChip({ level }) {
  const meta = level ? LEVEL_META[level] : null
  if (!meta) return null
  return (
    <Badge tone={meta.tone} size="sm" icon={meta.icon}>
      <span className="sr-only">Severity: </span>
      {meta.label}
    </Badge>
  )
}

/** Road-sign empty state: an empty street and a sign, in the brand's signage language. */
function EmptyPulse({ title, description, className }) {
  return (
    <div className={cn('flex flex-col items-center gap-4 rounded-xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center', className)}>
      <svg viewBox="0 0 220 120" className="h-24 w-auto" aria-hidden="true" focusable="false">
        <path d="M30 118 L96 34 L124 34 L190 118 Z" className="fill-asphalt-200 dark:fill-asphalt-800" />
        <path d="M110 40 L110 52 M110 62 L110 78 M110 90 L110 116" className="stroke-marking-500" strokeWidth="3" strokeLinecap="round" />
        <rect x="146" y="40" width="4" height="70" rx="1" className="fill-asphalt-400 dark:fill-asphalt-600" />
        <rect x="120" y="14" width="58" height="34" rx="6" className="fill-sign-600" />
        <rect x="123.5" y="17.5" width="51" height="27" rx="4" fill="none" stroke="#ffffff" strokeWidth="1.6" />
        <path d="M134 31 h30" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <div className="max-w-sm">
        <p className="font-display text-base font-bold text-ink">{title}</p>
        <p className="mt-1 text-sm text-ink-2">{description}</p>
      </div>
    </div>
  )
}

function PulseSkeleton({ className }) {
  return (
    <div className={cn('@container min-w-0', className)} aria-busy="true">
      <div className="grid gap-4 @2xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <div className="aspect-[4/3] w-full animate-pulse rounded-xl bg-sunken @md:aspect-[16/10]" />
        <div className="grid content-start gap-2">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="h-11 animate-pulse rounded-lg bg-sunken" />
          ))}
        </div>
      </div>
      <span className="sr-only">Loading hotspots</span>
    </div>
  )
}

export function CityPulse3D({
  clusters,
  onSelect,
  loading = false,
  className,
  emptyTitle = 'No hotspots in this period',
  emptyDescription = 'When several complaints are reported close together, the cluster appears here as a column.',
}) {
  const theme = resolveTheme(useContext(ThemeContext))
  const items = useMemo(() => prepareClusters(clusters), [clusters])
  const [active, setActive] = useState(null)

  if (loading && !items.length) return <PulseSkeleton className={className} />
  if (!items.length) return <EmptyPulse title={emptyTitle} description={emptyDescription} className={className} />

  const shown = active !== null && items[active] ? active : 0
  const featured = items[shown]
  const select = (index) => onSelect?.(items[index].cluster)
  const leave = (index) => setActive((current) => (current === index ? null : current))

  return (
    <div className={cn('@container min-w-0', className)}>
      <div className="grid gap-4 @2xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] @2xl:items-start">
        {/* The figure is the chip's container: below 30rem (PulseScene's NARROW) the chip is one compact line. */}
        <figure className="@container relative m-0 min-w-0 overflow-hidden rounded-xl border border-line bg-sunken">
          <div className="relative aspect-[4/3] w-full @md:aspect-[16/10]">
            <SceneCanvas
              className="absolute inset-0"
              interactive
              label={`3D view of ${items.length} complaint ${items.length === 1 ? 'hotspot' : 'hotspots'}, column height by number of complaints. The same hotspots are listed next to it.`}
              fallback={<PulseStill items={items} active={active} theme={theme} />}
            >
              <PulseScene items={items} active={active} onHover={setActive} onSelect={select} theme={theme} />
            </SceneCanvas>
          </div>
          <figcaption className="pointer-events-none absolute inset-x-2 bottom-2 flex justify-start @min-[30rem]:inset-x-3 @min-[30rem]:bottom-3">
            <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-white/10 bg-asphalt-950/75 px-2.5 py-1 text-white shadow-overlay backdrop-blur-md @min-[30rem]:gap-3 @min-[30rem]:px-3 @min-[30rem]:py-2">
              <span aria-hidden className="size-2 shrink-0 rounded-full ring-2 ring-white/70 @min-[30rem]:size-2.5" style={{ backgroundColor: featured.color }} />
              <span className="flex min-w-0 items-baseline gap-1.5 @min-[30rem]:block">
                <span className="block min-w-0 truncate font-display text-[13px] font-bold leading-tight @min-[30rem]:text-sm">{featured.label}</span>
                <span className="block shrink-0 text-[11px] text-asphalt-200 tabular @min-[30rem]:text-xs">{complaints(featured.count)}</span>
              </span>
              {featured.level ? (
                <span className="shrink-0 rounded-md bg-white/10 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                  {LEVEL_META[featured.level].label}
                </span>
              ) : null}
            </div>
          </figcaption>
        </figure>

        <ol aria-label="Hotspots, largest first" className="grid min-w-0 content-start gap-1">
          {items.map((item, index) => {
            const isActive = active === index
            const content = (
              <>
                <span aria-hidden className="w-5 shrink-0 text-right text-xs font-bold text-ink-3 tabular">
                  {index + 1}
                </span>
                <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{item.label}</span>
                  <span className="block text-xs text-ink-2 tabular">{complaints(item.count)}</span>
                </span>
                <SeverityChip level={item.level} />
              </>
            )
            const rowClass = cn(
              'flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150',
              isActive ? 'bg-surface-2 ring-1 ring-line-strong' : 'hover:bg-surface-2',
            )
            return (
              <li key={item.key} className="min-w-0">
                {onSelect ? (
                  <button
                    type="button"
                    className={rowClass}
                    onMouseEnter={() => setActive(index)}
                    onMouseLeave={() => leave(index)}
                    onFocus={() => setActive(index)}
                    onBlur={() => leave(index)}
                    onClick={() => select(index)}
                  >
                    {content}
                  </button>
                ) : (
                  <div className={rowClass} onMouseEnter={() => setActive(index)} onMouseLeave={() => leave(index)}>
                    {content}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

export default CityPulse3D
