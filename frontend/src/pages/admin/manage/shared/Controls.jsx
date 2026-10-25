/**
 * Small controls shared by the admin management screens.
 *
 * - FilterChip: a toggle chip (`aria-pressed`) for quick filters, with an optional live count.
 * - SegmentedControl: two to four mutually exclusive views (List / Map) as pressed buttons.
 * - PersonCell: avatar + name + a secondary line, for tables and lists.
 * - SummaryLine: "160 complaints" style result counts with a refresh hint.
 * - ListPagination: the shared Pagination for a page envelope `{count, page, page_size, total_pages}`;
 *   renders nothing for a single page. It lays the Previous / Next buttons out as flex rows (the shared
 *   component's `inline-grid` buttons stack the chevron above the label).
 *
 * Motion: chips and segments press in like every button (`pressable`); the selected segment's thumb slides to
 * the new choice on the indicator spring, under the labels. Reduced motion: instant.
 */
import { motion } from 'framer-motion'
import { useId } from 'react'
import { SPRING } from '@/components/motion/tokens'
import { Avatar } from '@/components/ui/Avatar'
import { Pagination } from '@/components/ui/Pagination'
import { Spinner } from '@/components/ui/Spinner'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'
import { renderIcon } from '@/utils/icons'

const ICON_TONES = {
  red: 'text-signal-600 dark:text-signal-300',
  orange: 'text-hazard-600 dark:text-hazard-300',
  blue: 'text-guide-600 dark:text-guide-200',
  yellow: 'text-marking-700 dark:text-marking-300',
  neutral: 'text-ink-3',
}

/**
 * @param {{active: boolean, onClick: () => void, label: string, icon?: import('react').ComponentType,
 *   iconTone?: 'red'|'orange'|'blue'|'yellow'|'neutral', count?: number|null, countLoading?: boolean,
 *   description?: string, className?: string}} props
 */
export function FilterChip({ active, onClick, label, icon, iconTone = 'neutral', count, countLoading = false, description, className }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={description}
      className={cn(
        'pressable inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full pl-3 pr-2 text-sm font-semibold ring-1 ring-inset pointer-coarse:h-11',
        active ? 'bg-ink text-surface ring-ink' : 'bg-surface text-ink-2 ring-line-strong hover:bg-surface-2 hover:text-ink',
        count == null && !countLoading && 'pr-3',
        className,
      )}
    >
      {renderIcon(icon, { className: cn('size-4 shrink-0', !active && ICON_TONES[iconTone]) })}
      <span>{label}</span>
      {countLoading ? (
        <Spinner size="xs" decorative className="mx-1" />
      ) : count != null ? (
        <span
          className={cn(
            'grid min-w-6 place-items-center rounded-full px-1.5 py-px text-xs font-bold tabular',
            active ? 'bg-surface/20 text-surface' : 'bg-sunken text-ink-2',
          )}
        >
          <span className="sr-only">, </span>
          {formatNumber(count)}
          <span className="sr-only"> complaints</span>
        </span>
      ) : null}
    </button>
  )
}

/**
 * @param {{value: string, onChange: (value: string) => void, label: string,
 *   options: Array<{value: string, label: string, icon?: import('react').ComponentType}>, className?: string}} props
 */
export function SegmentedControl({ value, onChange, label, options, className }) {
  const thumbId = useId()
  return (
    <div role="group" aria-label={label} className={cn('isolate inline-flex shrink-0 rounded-lg bg-sunken p-0.5', className)}>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'pressable relative inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold pointer-coarse:h-11',
              selected ? 'text-ink' : 'text-ink-2 hover:text-ink',
            )}
          >
            {selected ? (
              <motion.span
                aria-hidden
                layoutId={`view-thumb-${thumbId}`}
                transition={SPRING.indicator}
                className="absolute inset-0 rounded-md bg-surface shadow-[var(--shadow-raise)]"
              />
            ) : null}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {renderIcon(option.icon, { className: 'size-4' })}
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * @param {{name: string, avatar?: string|null, secondary?: import('react').ReactNode, size?: 'xs'|'sm'|'md', className?: string}} props
 */
export function PersonCell({ name, avatar, secondary, size = 'sm', className }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <Avatar src={avatar} name={name} size={size} decorative />
      <span className="min-w-0">
        <span className="block truncate font-semibold text-ink">{name}</span>
        {secondary ? <span className="block truncate text-xs text-ink-3">{secondary}</span> : null}
      </span>
    </span>
  )
}

/**
 * "160 complaints" + an optional "Updating" spinner while a refetch runs.
 * @param {{count?: number|null, noun: string, plural?: string, loading?: boolean, children?: import('react').ReactNode}} props
 */
export function SummaryLine({ count, noun, plural, loading = false, children, className }) {
  const known = typeof count === 'number'
  const word = known && count === 1 ? noun : (plural ?? `${noun}s`)
  return (
    <p aria-live="polite" className={cn('flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2', className)}>
      {known ? (
        <span>
          <span className="font-semibold text-ink tabular">{formatNumber(count)}</span> {word}
        </span>
      ) : null}
      {children}
      {loading ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
          <Spinner size="xs" decorative />
          Updating
        </span>
      ) : null}
    </p>
  )
}

/**
 * @param {{data?: {count: number, page?: number, page_size?: number, total_pages: number}|null, page: number,
 *   pageSize: number, onPageChange: (page: number) => void, className?: string}} props
 */
export function ListPagination({ data, page, pageSize, onPageChange, className }) {
  if (!data || !(Number(data.total_pages) > 1)) return null
  return (
    <Pagination
      className={cn('mt-4 [&_button]:inline-flex [&_button]:items-center [&_button]:justify-center', className)}
      page={data.page ?? page}
      totalPages={data.total_pages}
      count={data.count}
      pageSize={data.page_size ?? pageSize}
      onPageChange={onPageChange}
    />
  )
}
