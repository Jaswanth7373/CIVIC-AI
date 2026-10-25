/**
 * KpiStrip - the headline numbers of an insight page as ONE panel divided by hairlines (a departure board,
 * not a grid of identical cards). Each cell: label (with a small icon in its meaning colour), the number in
 * Overpass, and a short hint. A cell with `to` is a link to the records behind the number.
 *
 * Props:
 * - items: `[{key, label, value, format?, unit?, hint?, icon?, tone?, to?, title?, primary?, alert?}]`
 *   value: number (Indian digit grouping, or `format(n)`) or a preformatted string; unit: small suffix
 *   ("/ 5", "%"); format: how a numeric value is written ("3.9", "1 d 14 h", "81%") - it also writes the
 *   in-between numbers while the value counts up
 *   tone: neutral | green | yellow | orange | red | blue | violet | teal - colours the icon only
 *   primary (command variant): a headline figure - large, first in reading order; alert: it needs action
 *   (the number and the cell's signal edge take the tone colour; a zero stays calm)
 * - loading: skeletons instead of values (first load)
 * - error / onRetry: a failure message with a retry button instead of the cells
 * - label: accessible name of the list (default "Key figures")
 * - scanning: the AI scan band keeps sweeping over the board (e.g. while "Run checks now" runs)
 * - intro: play the entrance (scan pass + count-ups) when the board is first seen (default true). With
 *   `intro={false}` - a return visit in the same session - the numbers are simply there; a later change still
 *   gets a pass of the band and counts from the number on screen.
 * - variant: 'board' (default) or 'command' - the operations "command band" of the admin dashboard: a night
 *   panel (dark in both themes, like the sidebar and the city at night) where the `primary` figures - what
 *   needs action now - are large and lead, and the other figures are compact readouts beside them (xl) or
 *   under them. `heading` names the primary group.
 * - className
 *
 * Motion: when the board is first seen, the AI scan - a band of road-marking light, the survey light of the 3D
 * city - passes over it once, and each number counts up as the band reaches its cell (positions are measured,
 * so the order follows the layout at any width). Each value stays ONE text node holding the final, formatted
 * number in the DOM (CountUp), so tests and screen readers always read the real figure. New numbers after a
 * filter change count from the old ones under a second pass of the band. Linked cells answer the pointer and
 * keyboard focus with a short marker in their tone colour along the bottom edge. Reduced motion: final
 * numbers, no band.
 *
 * Responsive (board): 2 columns on phones, 3-4 from md, all in one row from xl. With an odd number of cells
 * the first one spans two columns on small screens, so the panel never ends with a ragged empty slot. Hints
 * keep two lines of room, loading or not, so every row has one height and nothing moves when the numbers
 * arrive. Command band: phones lead with the first primary figure across the full width and the next two
 * side by side; from sm the primary figures share one row; from xl they stand as tall columns on the left
 * half and the compact readouts fill the right half.
 */
import { cubicBezier } from 'framer-motion'
import { ArrowUpRight, RefreshCw, TriangleAlert } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CountUp } from '@/components/motion/CountUp'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'
import { getErrorMessage } from '@/utils/errors'
import { renderIcon } from '@/utils/icons'
import '@/styles/admin.css'
import './opsCommand.css'

const ICON_TONES = {
  neutral: 'text-ink-3',
  green: 'text-sign-600 dark:text-sign-300',
  yellow: 'text-marking-600 dark:text-marking-300',
  orange: 'text-hazard-600 dark:text-hazard-300',
  red: 'text-signal-600 dark:text-signal-300',
  blue: 'text-guide-600 dark:text-guide-300',
  violet: 'text-violet-600 dark:text-violet-300',
  teal: 'text-teal-600 dark:text-teal-300',
}

/** Hover / focus marker of a linked cell, in the same meaning colour as its icon. */
const MARKER_TONES = {
  neutral: 'bg-ink-3',
  green: 'bg-sign-500',
  yellow: 'bg-marking-500',
  orange: 'bg-hazard-500',
  red: 'bg-signal-500',
  blue: 'bg-guide-500 dark:bg-guide-400',
  violet: 'bg-violet-500',
  teal: 'bg-teal-500',
}

/** An alerting primary figure: its number and the signal edge along the top of the cell (night panel). */
const ALERT_TONES = {
  neutral: { number: 'text-ink', edge: 'bg-ink-3 text-ink-3' },
  green: { number: 'text-sign-300', edge: 'bg-sign-400 text-sign-400' },
  yellow: { number: 'text-marking-300', edge: 'bg-marking-400 text-marking-400' },
  orange: { number: 'text-hazard-300', edge: 'bg-hazard-400 text-hazard-400' },
  red: { number: 'text-signal-300', edge: 'bg-signal-400 text-signal-400' },
  blue: { number: 'text-guide-300', edge: 'bg-guide-400 text-guide-400' },
  violet: { number: 'text-violet-300', edge: 'bg-violet-400 text-violet-400' },
  teal: { number: 'text-teal-300', edge: 'bg-teal-400 text-teal-400' },
}

/*
 * Command band grid (class names written out in full for Tailwind's scanner). Six columns up to lg: the first
 * primary figure spans the row on phones, the next two share one; from sm all primary figures share a row;
 * the first readout (the total) spans a row and the others pair up. From xl six tracks, two rows high: the
 * primary figures are tall columns on the left; on the right the total (two tracks wide, with its status bar)
 * and the other readouts fill a three-by-two block (those tracks are a little wider for their longer labels).
 */
const COMMAND_GRID = 'grid-cols-6 xl:grid-cols-[repeat(3,minmax(0,1fr))_repeat(3,minmax(0,1.4fr))]'
const COMMAND_PRIMARY = ['col-span-6 sm:col-span-2 xl:col-span-1 xl:row-span-2', 'col-span-3 sm:col-span-2 xl:col-span-1 xl:row-span-2']
const COMMAND_SECONDARY = ['col-span-6 xl:col-span-2', 'col-span-3 xl:col-span-1']

/**
 * Grid layouts by cell count (class names written out in full for Tailwind's scanner). Cells stay at least
 * ~170 px wide so labels fit on one line and every value sits on the same baseline; seven cells only share
 * one row from 2xl, below that the first ("hero") cell spans two columns and the panel has two even rows.
 */
const LAYOUTS = {
  3: { grid: 'grid-cols-2 sm:grid-cols-3', first: 'col-span-2 sm:col-span-1' },
  4: { grid: 'grid-cols-2 lg:grid-cols-4', first: '' },
  5: { grid: 'grid-cols-2 md:grid-cols-5', first: 'col-span-2 md:col-span-1' },
  6: { grid: 'grid-cols-2 md:grid-cols-3 2xl:grid-cols-6', first: '' },
  7: { grid: 'grid-cols-2 md:grid-cols-4 2xl:grid-cols-7', first: 'col-span-2 2xl:col-span-1' },
  8: { grid: 'grid-cols-2 md:grid-cols-4 2xl:grid-cols-8', first: '' },
}

/*
 * Hairlines: every cell draws an INSET line on its left and top edge (inset shadows are painted inside the
 * cell, so a neighbour's background can never cover them). The grid is pulled 1 px up and left inside the
 * clipping panel, which hides the lines of the first row and column - only the dividers remain.
 */
const HAIRLINES = 'shadow-[inset_1px_0_0_0_var(--c-line),inset_0_1px_0_0_var(--c-line)]'
const CELL = `relative flex min-w-0 flex-col bg-surface p-4 sm:px-5 ${HAIRLINES}`
/** Command band cells: the night panel shows through; the primary figures get more room. */
const COMMAND_CELL = `relative flex min-w-0 flex-col p-4 sm:px-5 ${HAIRLINES}`
const COMMAND_PRIMARY_CELL = '@container pb-5 sm:pb-6 xl:pt-5'

/*
 * The scan band (styles/admin.css `.ops-scan`): it waits SCAN_DELAY, then its centre travels from -6 % to
 * 106 % of the board width in SCAN_DURATION on SCAN_EASE. A number appears and starts counting when the
 * band's centre reaches the middle of its cell (a little before, so the count and the light arrive together).
 */
const SCAN_DELAY = 0.05
const SCAN_DURATION = 1.15
const SCAN_EASE = cubicBezier(0.25, 0.1, 0.3, 1)
const COUNT_DURATION = 0.9
const COUNT_LEAD = 0.08
/** The count starts a moment before its value fades in, so the first figure anyone sees is never a bare zero. */
const COUNT_HEAD_START = 0.15

/** Seconds after the board appears at which the band's centre passes `x` (0..1 of the board width). */
function scanArrival(x) {
  const target = Math.min(1, Math.max(0, (x + 0.06) / 1.12))
  let low = 0
  let high = 1
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2
    if (SCAN_EASE(mid) < target) low = mid
    else high = mid
  }
  return Math.max(0, SCAN_DELAY + low * SCAN_DURATION - COUNT_LEAD)
}

/** The text a value ends on ("1,234", "1 d 14 h"): its length sizes a primary figure to fit its cell. */
function finalText(item) {
  if (typeof item.value === 'number' && Number.isFinite(item.value)) {
    return item.format ? item.format(item.value) : formatNumber(item.value)
  }
  return String(item.value ?? '—')
}

function CellBody({ item, loading, linked, delay, reading, from, size = 'board' }) {
  const primary = size === 'primary'
  const compact = size === 'compact'
  const alert = primary && item.alert ? (ALERT_TONES[item.tone] ?? ALERT_TONES.neutral) : null
  return (
    <>
      {alert ? <span aria-hidden className={cn('ops-command-edge', alert.edge)} /> : null}
      <p
        className={cn(
          'flex items-start gap-1.5 pr-4 leading-snug text-ink-2',
          primary ? 'text-sm font-semibold' : compact ? 'text-xs font-medium' : 'text-[13px] font-medium',
        )}
      >
        {item.icon
          ? renderIcon(item.icon, { className: cn('mt-px size-4 shrink-0', ICON_TONES[item.tone] ?? ICON_TONES.neutral) })
          : null}
        <span className="min-w-0">{item.label}</span>
      </p>
      {linked ? (
        <ArrowUpRight
          aria-hidden
          className="absolute right-3 top-3.5 size-4 -translate-x-0.5 translate-y-0.5 text-ink-3 opacity-0 transition-[opacity,translate] duration-200 ease-standard group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:translate-y-0 group-focus-visible:opacity-100"
        />
      ) : null}
      <div
        className={cn(
          'flex items-baseline gap-1',
          primary ? 'mt-3 min-h-12 sm:min-h-14 xl:mt-auto xl:min-h-[4.5rem] xl:pt-5' : compact ? 'mt-1.5 min-h-7' : 'mt-2.5 min-h-8',
          reading && !loading && 'ops-reading',
        )}
        style={reading && !loading ? { '--read-delay': `${delay.toFixed(3)}s` } : undefined}
      >
        {loading ? (
          <Skeleton className={primary ? 'h-10 w-20 xl:h-14' : compact ? 'h-6 w-16' : 'h-7 w-20'} />
        ) : (
          <>
            <CountUp
              value={item.value ?? null}
              format={item.format}
              from={from}
              delay={reading ? Math.max(0, delay - COUNT_HEAD_START) : delay}
              duration={COUNT_DURATION}
              className={cn(
                'font-display font-extrabold leading-none tabular',
                primary ? 'ops-command-figure tracking-[-0.035em]' : compact ? 'text-2xl tracking-tight' : 'text-[1.75rem] tracking-tight',
                alert ? alert.number : 'text-ink',
              )}
              style={primary ? { '--digits': Math.max(2, finalText(item).length) } : undefined}
            />
            {item.unit ? <span className="text-sm font-bold text-ink-3">{item.unit}</span> : null}
          </>
        )}
      </div>
      {item.hint !== undefined && item.hint !== null ? (
        <div
          className={cn(
            'text-xs leading-snug text-ink-3',
            primary ? 'mt-2 min-h-[2lh] max-w-60' : compact ? 'mt-1.5' : 'mt-2 min-h-[2lh]',
          )}
        >
          {loading ? <Skeleton className="h-3 w-28" /> : item.hint}
        </div>
      ) : null}
      {linked ? (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-4 bottom-0 h-[3px] origin-left scale-x-0 rounded-t-full transition-transform duration-300 ease-standard group-hover:scale-x-100 group-focus-visible:scale-x-100 sm:inset-x-5',
            MARKER_TONES[item.tone] ?? MARKER_TONES.neutral,
          )}
        />
      ) : null}
    </>
  )
}

export function KpiStrip({
  items = [],
  loading = false,
  error,
  onRetry,
  label = 'Key figures',
  scanning = false,
  intro = true,
  variant = 'board',
  heading,
  className,
}) {
  const visible = items.filter(Boolean)
  const command = variant === 'command'
  const layout = LAYOUTS[visible.length] ?? LAYOUTS[4]
  const boardRef = useRef(null)
  const reduced = usePrefersReducedMotion()
  const seen = useInViewOnce(boardRef)
  const [delays, setDelays] = useState([])
  const ready = !loading && visible.length > 0
  // A new set of numbers (first load, a filter change) gets a pass of the band; a refetch with the same
  // numbers does not.
  const signature = ready ? visible.map((item) => `${item.key}:${String(item.value)}`).join('|') : ''
  // Without the intro, the first numbers this board shows are its starting point: no pass, no count for them.
  const [baseline, setBaseline] = useState(() => (intro ? null : signature || null))
  if (!intro && baseline === null && signature) setBaseline(signature)
  const reading = !reduced && intro

  // Count start of every cell from its measured position, before the first paint of the numbers.
  useLayoutEffect(() => {
    const board = boardRef.current
    if (!ready || reduced || !board) return
    const box = board.getBoundingClientRect()
    const cells = board.querySelectorAll(':scope > ul > li')
    setDelays(
      [...cells].map((cell) => {
        const rect = cell.getBoundingClientRect()
        return scanArrival((rect.left + rect.width / 2 - box.left) / Math.max(1, box.width))
      }),
    )
  }, [ready, reduced, visible.length])

  if (error && !loading) {
    return (
      <div
        role="alert"
        className={cn(
          'flex flex-col items-start gap-3 rounded-xl border border-signal-200 bg-surface p-4 sm:flex-row sm:items-center dark:border-signal-500/30',
          className,
        )}
      >
        <TriangleAlert aria-hidden className="size-5 shrink-0 text-signal-600 dark:text-signal-300" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">The key figures could not load</p>
          <p className="text-sm text-ink-2">{getErrorMessage(error)}</p>
        </div>
        {onRetry ? (
          <Button variant="outline" size="sm" leftIcon={RefreshCw} onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    )
  }

  const fresh = intro || signature !== baseline
  const scanMode = reduced ? null : scanning ? 'loop' : ready && seen && fresh ? 'once' : null
  let primaryIndex = 0
  let secondaryIndex = 0

  return (
    <div
      ref={boardRef}
      data-seen={seen || undefined}
      className={cn(
        'relative overflow-hidden',
        // The command band is a night panel in both themes: `dark` scopes the dark tokens to it.
        command ? 'ops-command dark rounded-2xl text-ink' : 'rounded-xl border border-line bg-surface',
        className,
      )}
    >
      {command && heading ? (
        <p className="relative flex items-center gap-2 px-4 pb-1 pt-3.5 text-xs font-semibold text-ink-2 sm:px-5">
          <span aria-hidden className="ops-command-lamp" />
          {heading}
        </p>
      ) : null}
      <ul
        aria-label={label}
        aria-busy={loading || undefined}
        className={cn('-ml-px -mt-px grid', command ? COMMAND_GRID : layout.grid)}
      >
        {visible.map((item, index) => {
          const delay = delays[index] ?? 0
          let span
          let size = 'board'
          if (command) {
            if (item.primary) {
              span = COMMAND_PRIMARY[Math.min(primaryIndex, 1)]
              primaryIndex += 1
              size = 'primary'
            } else {
              span = COMMAND_SECONDARY[Math.min(secondaryIndex, 1)]
              secondaryIndex += 1
              size = 'compact'
            }
          } else {
            span = index === 0 ? layout.first : ''
          }
          const cellClass = command
            ? cn(COMMAND_CELL, size === 'primary' ? COMMAND_PRIMARY_CELL : 'xl:px-4')
            : CELL
          // A return visit starts each number where it stands (no count from zero).
          const from = intro || typeof item.value !== 'number' ? 0 : item.value
          const body = (linked) => (
            <CellBody item={item} loading={loading} delay={delay} reading={reading} from={from} size={size} linked={linked} />
          )
          return (
            <li key={item.key ?? index} className={cn('flex min-w-0', span)}>
              {item.to && !loading ? (
                <Link
                  to={item.to}
                  title={item.title}
                  className={cn(
                    cellClass,
                    'group w-full transition-colors duration-200 focus-visible:-outline-offset-2',
                    command ? 'hover:bg-white/[0.035]' : 'hover:bg-surface-2',
                  )}
                >
                  {body(true)}
                </Link>
              ) : (
                <div className={cn(cellClass, 'w-full')} title={item.title}>
                  {body(false)}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {scanMode ? <span aria-hidden key={scanMode === 'loop' ? 'loop' : signature} className="ops-scan" data-scan={scanMode} /> : null}
    </div>
  )
}

export default KpiStrip
