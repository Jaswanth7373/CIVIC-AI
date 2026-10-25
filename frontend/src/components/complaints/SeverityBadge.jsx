/**
 * SeverityBadge - AI-assessed severity of the issue ("High", optionally with its 0-100 score).
 *
 * Props:
 * - severity: 'low' | 'medium' | 'high' | 'critical' (alias: `level`); empty -> "Not assessed"
 * - score: optional 0-100 severity score, shown after the level in tabular figures
 * - withLabel: show the word "severity" ("High severity") - useful outside a labelled column
 * - size: 'sm' | 'md' | 'lg' (default 'md')
 * - className
 *
 * A plain word led by a level dot (green -> yellow -> orange -> red, from LEVEL_META), not a chip: severity
 * usually sits next to the priority chip (PriorityBadge), and the two must never look alike. The level is
 * always written out, so it is never conveyed by colour alone.
 */
import { CircleDashed } from 'lucide-react'
import { cn } from '@/utils/cn'
import { getLevelMeta } from '@/utils/constants'

const SIZES = { sm: 'gap-1.5 text-xs', md: 'gap-1.5 text-[13px]', lg: 'gap-2 text-sm' }
const DOT_SIZES = { sm: 'size-2', md: 'size-2.5', lg: 'size-3' }
const ICON_SIZES = { sm: 'size-3', md: 'size-3.5', lg: 'size-4' }

export function SeverityBadge({ severity, level, score, withLabel = false, size = 'md', className }) {
  const meta = getLevelMeta(severity ?? level)
  const base = cn('inline-flex max-w-full shrink-0 items-center whitespace-nowrap font-semibold leading-5', SIZES[size] ?? SIZES.md)
  if (!meta) {
    return (
      <span className={cn(base, 'text-ink-3', className)}>
        <CircleDashed aria-hidden className={cn('shrink-0', ICON_SIZES[size] ?? ICON_SIZES.md)} />
        <span className="sr-only">Severity: </span>
        <span className="truncate">Not assessed</span>
      </span>
    )
  }
  const hasScore = score !== null && score !== undefined && score !== '' && Number.isFinite(Number(score))
  return (
    <span title={meta.description} className={cn(base, 'text-ink-2', className)}>
      <span
        aria-hidden
        className={cn('shrink-0 rounded-full ring-1 ring-black/10 ring-inset dark:ring-white/15', DOT_SIZES[size] ?? DOT_SIZES.md)}
        style={{ backgroundColor: meta.color }}
      />
      <span className="truncate">
        <span className="sr-only">Severity: </span>
        {withLabel ? `${meta.label} severity` : meta.label}
        {hasScore ? (
          <>
            <span className="sr-only">, score</span>
            <span className="ml-1 font-bold text-ink tabular">{Math.round(Number(score))}</span>
          </>
        ) : null}
      </span>
    </span>
  )
}

export default SeverityBadge
