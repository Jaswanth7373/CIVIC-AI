import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'

const COLUMNS = { 1: 'grid-cols-1', 2: 'grid-cols-1 sm:grid-cols-2', 3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' }

/**
 * Definition list for record details (`<dl>`). Empty values show an em dash.
 *
 * @param {object} props
 * @param {Array<{label: import('react').ReactNode, value: import('react').ReactNode, icon?: import('react').ComponentType, fullWidth?: boolean}>} props.items
 * @param {1|2|3} [props.columns=1]
 * @param {'stacked'|'inline'} [props.layout='stacked'] `inline` puts the label left and the value right
 */
export function KeyValueList({ items = [], columns = 1, layout = 'stacked', className }) {
  const visible = items.filter(Boolean)
  return (
    <dl className={cn('grid gap-x-6', layout === 'inline' ? 'gap-y-2.5' : 'gap-y-4', COLUMNS[columns] ?? COLUMNS[1], className)}>
      {visible.map((item, index) => {
        const empty = item.value === null || item.value === undefined || item.value === ''
        return (
          <div
            key={typeof item.label === 'string' ? item.label : index}
            className={cn(
              'min-w-0',
              layout === 'inline' && 'flex items-baseline justify-between gap-4',
              item.fullWidth && 'sm:col-span-full',
            )}
          >
            <dt className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
              {renderIcon(item.icon, { className: 'size-3.5' })}
              {item.label}
            </dt>
            <dd className={cn('min-w-0 break-words text-sm text-ink', layout === 'inline' ? 'text-right font-medium' : 'mt-0.5')}>
              {empty ? '—' : item.value}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

export default KeyValueList
