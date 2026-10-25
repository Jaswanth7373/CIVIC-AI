import { Link } from 'react-router-dom'
import { CountUp } from '@/components/motion/CountUp'
import { TiltCard } from '@/components/motion/TiltCard'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'
import { renderIcon } from '@/utils/icons'
import { Skeleton } from './Skeleton'
import { resolveTone, toneChip } from './tones'

const formatWhole = (value) => formatNumber(value)

/**
 * Key number on a dashboard. The value is set in Overpass with tabular numerals so figures line up.
 * Numbers are formatted with Indian digit grouping and count up from zero the first time the card is seen
 * (final value at once with reduced motion); strings (e.g. "2 d 4 h", "91%") are shown as given.
 *
 * Markup contract (tests and pages rely on it): label `<p>`, value `<p>` (a single text node), optional hint
 * `<p>`, in that order. With `to` the whole card is a link that leans toward the pointer (TiltCard) and rises
 * onto the raised elevation; without it the card stays a flat panel.
 *
 * @param {object} props
 * @param {import('react').ReactNode} props.label
 * @param {number|string|null} props.value
 * @param {import('react').ComponentType} [props.icon]
 * @param {'neutral'|'green'|'yellow'|'orange'|'red'|'blue'|'violet'|'teal'|'magenta'|'slate'} [props.tone='neutral']
 * @param {import('react').ReactNode} [props.hint] small text under the value
 * @param {string} [props.to] makes the whole card a link (e.g. to the filtered list)
 * @param {boolean} [props.loading]
 */
export function StatCard({ label, value, icon, tone = 'neutral', hint, to, loading = false, className }) {
  const body = (
    <>
      {/* The label row is always two lines tall (the icon chip is 36px anyway), so in a grid of tiles - most of
          all the two-column grid on phones, where some labels wrap and others do not - every value sits at
          the same height. */}
      <div className="flex min-h-10 items-start justify-between gap-3">
        <p className="text-sm font-medium leading-5 text-ink-2">{label}</p>
        {icon ? (
          <span
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-lg transition-[translate,rotate] duration-300 ease-spring',
              toneChip[resolveTone(tone)],
              to && 'group-hover/stat:-translate-y-0.5 group-hover/stat:-rotate-3',
            )}
          >
            {renderIcon(icon, { className: 'size-[18px]' })}
          </span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton className="h-8 w-24" />
      ) : (
        <CountUp
          as="p"
          value={value}
          format={formatWhole}
          className="font-display text-3xl font-extrabold leading-none tracking-tight text-ink tabular"
        />
      )}
      {hint ? <p className="text-xs text-ink-3">{loading ? ' ' : hint}</p> : null}
    </>
  )
  const classes = cn('flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4', className)

  if (to) {
    return (
      <TiltCard
        as={Link}
        to={to}
        max={5}
        className={cn(
          classes,
          'group/stat transition-[border-color,box-shadow] duration-200 ease-standard hover:border-line-strong hover:elev-raised',
        )}
      >
        {body}
      </TiltCard>
    )
  }
  return <div className={classes}>{body}</div>
}

export default StatCard
