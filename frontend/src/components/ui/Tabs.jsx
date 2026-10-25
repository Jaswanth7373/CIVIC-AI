import { motion } from 'framer-motion'
import { useId, useRef } from 'react'
import { SPRING } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'

/**
 * Underline tabs with a yellow road-marking active marker (WAI-ARIA tabs pattern: roving tabindex, Left /
 * Right / Home / End move between tabs and select them). Horizontally scrollable on narrow screens.
 * Pair with <TabPanel> using the same `idPrefix` to link panels to tabs.
 *
 * Motion: the marker slides to the newly selected tab on a critically damped spring (a shared-layout
 * animation keyed to this tab list only); hovering an unselected tab previews a faint marker. With reduced
 * motion the marker simply moves.
 *
 * @param {object} props
 * @param {Array<{id: string, label: string, icon?: import('react').ComponentType, count?: number, disabled?: boolean}>} props.tabs
 * @param {string} props.value id of the selected tab
 * @param {(id: string) => void} props.onChange
 * @param {string} [props.idPrefix] stable prefix for tab / panel ids
 * @param {string} [props.label] accessible name of the tab list
 */
export function Tabs({ tabs = [], value, onChange, idPrefix, label, className }) {
  const autoId = useId()
  const prefix = idPrefix ?? autoId
  const markerId = `${prefix}-${autoId}-tab-marker`
  const listRef = useRef(null)

  const enabledTabs = tabs.filter((tab) => !tab.disabled)

  const select = (tab) => {
    onChange?.(tab.id)
    listRef.current?.querySelector(`[data-tab-id="${CSS.escape(String(tab.id))}"]`)?.focus()
  }

  const handleKeyDown = (event) => {
    const index = enabledTabs.findIndex((tab) => tab.id === value)
    const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: enabledTabs.length - 1 }
    if (!(event.key in moves) || !enabledTabs.length) return
    event.preventDefault()
    const next = enabledTabs[(moves[event.key] + enabledTabs.length) % enabledTabs.length]
    if (next) select(next)
  }

  return (
    <motion.div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
      layoutScroll
      className={cn('scrollbar-none flex gap-1 overflow-x-auto border-b border-line', className)}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${prefix}-tab-${tab.id}`}
            data-tab-id={tab.id}
            aria-selected={selected}
            aria-controls={`${prefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onChange?.(tab.id)}
            className={cn(
              'group/tab relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-2.5 text-sm font-semibold transition-colors duration-150 ease-standard focus-visible:-outline-offset-2 disabled:opacity-50 pointer-coarse:min-h-11',
              selected ? 'text-ink' : 'text-ink-3 hover:text-ink',
            )}
          >
            {renderIcon(tab.icon, { className: 'size-4' })}
            <span>{tab.label}</span>
            {typeof tab.count === 'number' ? (
              <span
                className={cn(
                  'rounded-full px-1.5 py-px text-xs font-semibold tabular transition-colors duration-200 ease-standard',
                  selected ? 'bg-ink text-surface' : 'bg-sunken text-ink-2',
                )}
              >
                {tab.count}
              </span>
            ) : null}
            {selected ? (
              <motion.span
                aria-hidden
                layoutId={markerId}
                transition={SPRING.indicator}
                className="absolute inset-x-2 -bottom-px h-[3px] rounded-full bg-marking-500"
              />
            ) : (
              <span
                aria-hidden
                className="absolute inset-x-2 -bottom-px h-[3px] scale-x-50 rounded-full bg-line-strong opacity-0 transition-[opacity,scale] duration-200 ease-standard group-hover/tab:scale-x-100 group-hover/tab:opacity-100 group-disabled/tab:hidden"
              />
            )}
          </button>
        )
      })}
    </motion.div>
  )
}

/**
 * Panel for a tab. Renders only while its tab is selected (`value === tabId`), unless `keepMounted`.
 * The panel is a tab stop (the WAI-ARIA tabs pattern), so it shows the global two-tone focus ring (index.css),
 * with rounded corners. (It used to carry outline-hidden, which zeroed --tw-outline-style, so no ring rendered.)
 * @param {{tabId: string, value: string, idPrefix: string, keepMounted?: boolean, className?: string}} props
 */
export function TabPanel({ tabId, value, idPrefix, keepMounted = false, className, children }) {
  const selected = tabId === value
  if (!selected && !keepMounted) return null
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${tabId}`}
      aria-labelledby={`${idPrefix}-tab-${tabId}`}
      hidden={!selected}
      tabIndex={0}
      className={cn('rounded-lg', className)}
    >
      {children}
    </div>
  )
}

export default Tabs
