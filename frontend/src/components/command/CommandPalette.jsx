import { AnimatePresence, LayoutGroup, motion } from 'framer-motion'
import { Bell, ClipboardList, CornerDownLeft, MapPinPlus, Moon, RefreshCw, Search, Sun } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { readableInk, safeColor } from '@/components/charts/palette'
import { DURATION, EASE, SPRING } from '@/components/motion/tokens'
import { Badge } from '@/components/ui/Badge'
import { Kbd } from '@/components/ui/Kbd'
import { useModalLayer } from '@/components/ui/overlay'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAuth } from '@/hooks/useAuth'
import { useDebounce } from '@/hooks/useDebounce'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { useNotifications } from '@/hooks/useNotifications'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/utils/cn'
import { getStatusMeta } from '@/utils/constants'
import { getIcon, renderIcon } from '@/utils/icons'
import { filterCommands, findThemeToggle, pageCommands, readRecents, rememberRecent } from './commands'
import { MIN_LENGTH, useComplaintSearch } from './useComplaintSearch'

const SEARCH_DELAY_MS = 220

const SCOPE_HINT = {
  citizen: 'In your complaints',
  officer: 'In your assigned complaints',
  admin: 'In every department',
}

/** DOM id of an option (ids may contain "/" and ":", which are fine in id attributes but not in selectors). */
const optionDomId = (listId, id) => `${listId}-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`

function complaintOption(row, role) {
  const number = row.complaint_number ?? `#${row.id}`
  return {
    id: `complaint:${row.id}`,
    kind: 'complaint',
    label: row.title || number,
    number,
    category: row.category?.name ?? null,
    icon: getIcon(row.category?.icon, ClipboardList),
    // The category's own colour (database data): the row's icon is the same category plate as CategoryBadge.
    color: row.category?.color ?? null,
    status: row.status,
    statusLabel: row.status_display,
    to: `/${role}/complaints/${row.id}`,
    remember: { kind: 'complaint', complaintId: row.id, number, title: row.title ?? '' },
  }
}

/**
 * The palette's content for the current query, as groups of options. Pure: everything it needs comes in.
 * Empty query: Recent, Quick actions, Go to. With a query: Complaints (a "search the list" row first, so Enter
 * always does what the topbar search does, then live results), matching actions and pages. While the results
 * of an earlier query are all there is (the new one is typed or on its way), its rows are marked `stale` - shown
 * dimmed under a "Searching…" heading, aria-disabled, skipped by the arrow keys and Enter, inert to clicks.
 */
function buildSections({ role, term, recents, search, quick, pages }) {
  const sections = []
  if (!term) {
    const recentOptions = recents
      .map((entry) => {
        if (entry.kind === 'page') {
          const page = pages.all.find((candidate) => candidate.to === entry.to)
          return page ? { ...page, id: `recent:${page.id}`, remember: { kind: 'page', to: page.to } } : null
        }
        return {
          id: `recent:complaint:${entry.complaintId}`,
          kind: 'complaint',
          label: entry.title || entry.number,
          number: entry.number,
          icon: ClipboardList,
          to: `/${role}/complaints/${entry.complaintId}`,
          remember: entry,
        }
      })
      .filter(Boolean)
    if (recentOptions.length) sections.push({ id: 'recent', label: 'Recent', options: recentOptions })
    sections.push({ id: 'actions', label: 'Quick actions', options: quick })
    sections.push({ id: 'pages', label: 'Go to', options: pages.listed })
    return sections
  }

  const complaintOptions = [
    {
      id: 'search:all',
      kind: 'search',
      label: `Search complaints for “${term}”`,
      sub: SCOPE_HINT[role] ?? null,
      icon: Search,
      to: `/${role}/complaints?search=${encodeURIComponent(term)}`,
    },
  ]
  let placeholder = null
  let searching = false
  if (term.length >= MIN_LENGTH) {
    const settled = search.status === 'done' && search.term === term
    // Rows found for an earlier query while the new one is on its way: dimmed and skipped, never opened.
    const stale = search.results.length > 0 && search.resultsTerm !== term
    searching = stale || search.status === 'loading'
    if (search.status === 'error') {
      complaintOptions.push({
        id: 'search:retry',
        kind: 'retry',
        label: "Couldn't search complaints",
        sub: 'Check the connection, then choose this to try again',
        icon: RefreshCw,
      })
    } else if (search.results.length) {
      complaintOptions.push(...search.results.map((row) => ({ ...complaintOption(row, role), stale })))
    } else if (settled) {
      placeholder = 'none'
    }
    if (search.status === 'loading' && !search.results.length) placeholder = 'loading'
  }
  sections.push({ id: 'complaints', label: searching ? 'Searching…' : 'Complaints', options: complaintOptions, placeholder, searching })

  const actions = filterCommands(quick, term)
  if (actions.length) sections.push({ id: 'actions', label: 'Quick actions', options: actions })
  const pageMatches = filterCommands(pages.all, term)
  if (pageMatches.length) sections.push({ id: 'pages', label: 'Go to', options: pageMatches })
  return sections
}

function OptionIcon({ option, active }) {
  // Complaint rows: the category plate used everywhere else (CategoryBadge, map pins) - the category's colour
  // with white or near-black ink, whichever reads better; highlighted, it gains the sign's inset border.
  if (option.kind === 'complaint' && option.color) {
    const fill = safeColor(option.color, '#6a7a77')
    const ink = readableInk(fill)
    return (
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-md transition-[box-shadow] duration-150 ease-standard"
        style={{
          backgroundColor: fill,
          color: ink,
          boxShadow: active ? `inset 0 0 0 2px ${fill}, inset 0 0 0 3.25px ${ink}` : undefined,
        }}
      >
        {renderIcon(option.icon, { className: 'size-4', strokeWidth: 2.4 })}
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md transition-[background-color,color,box-shadow] duration-150 ease-standard',
        // The highlighted row's icon becomes a small highway sign: green field, inset white border.
        active
          ? 'bg-sign-600 text-white shadow-[inset_0_0_0_2px_var(--color-sign-600),inset_0_0_0_3.25px_#fff]'
          : 'bg-sunken text-ink-2',
      )}
    >
      {renderIcon(option.icon, { className: 'size-4' })}
    </span>
  )
}

function PaletteOption({ option, domId, active, roomy, onHover, onRun }) {
  const status = option.status ? getStatusMeta(option.status) : null
  const stale = Boolean(option.stale)
  return (
    <div
      id={domId}
      role="option"
      aria-selected={active}
      aria-disabled={stale || undefined}
      onPointerMove={stale ? undefined : onHover}
      // Keep focus (and the caret) in the search box when an option is clicked.
      onMouseDown={(event) => event.preventDefault()}
      onClick={stale ? undefined : onRun}
      className={cn(
        'relative mx-2 flex min-h-12 select-none items-center gap-3 rounded-lg px-3 py-2 text-sm transition-opacity duration-150 ease-standard',
        stale ? 'cursor-default opacity-40' : 'cursor-pointer',
        active ? 'bg-surface-2 dark:bg-white/[0.06]' : !stale && 'hover:bg-surface-2/60',
      )}
    >
      {active ? (
        <motion.span
          aria-hidden
          layoutId="palette-active-lane"
          transition={SPRING.indicator}
          className="lane-line absolute -left-2 top-1/2 -mt-3.5 h-7 w-[3px] rounded-full"
        />
      ) : null}
      <OptionIcon option={option} active={active} />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-ink', option.kind === 'complaint' ? 'font-semibold' : 'font-medium')}>
          {option.label}
        </span>
        {option.kind === 'complaint' ? (
          <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-ink-3">
            <span className="shrink-0 tabular">{option.number}</span>
            {option.category ? <span className="truncate">{option.category}</span> : null}
          </span>
        ) : option.sub ? (
          <span className="mt-0.5 block truncate text-xs text-ink-3">{option.sub}</span>
        ) : null}
      </span>
      {status ? (
        <Badge size="sm" tone={status.tone} variant={status.variant ?? 'soft'} className="hidden min-[400px]:inline-flex">
          {status.label || option.statusLabel}
        </Badge>
      ) : null}
      {option.badge ? (
        <Badge size="sm" tone="red">
          {option.badge}
        </Badge>
      ) : null}
      {roomy ? (
        <Kbd aria-hidden className={cn('transition-opacity duration-150 pointer-coarse:hidden', active ? 'opacity-100' : 'opacity-0')}>
          <CornerDownLeft className="size-3" />
        </Kbd>
      ) : null}
    </div>
  )
}

function ComplaintSkeletons() {
  return (
    <div aria-hidden className="mx-2 space-y-1 px-3 py-1">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex min-h-12 items-center gap-3 py-1">
          <Skeleton className="size-8 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={cn('h-3.5', index === 1 ? 'w-1/2' : 'w-2/3')} />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The open palette (mounted only while open, so every opening starts fresh with an empty query).
 * Accessibility: a modal dialog (focus trap, Esc, scroll lock and inert page from useModalLayer) with an ARIA
 * 1.2 combobox: the input owns the listbox through aria-controls and points at the highlighted option with
 * aria-activedescendant, so focus never leaves the input; options are grouped (role="group", labelled by
 * their heading) and the number of results is announced politely.
 */
function PaletteDialog({ onClose, onRun }) {
  const { user, role } = useAuth()
  const { resolvedTheme, toggleTheme } = useTheme()
  const { unreadCount } = useNotifications()
  const roomy = useMediaQuery(BREAKPOINTS.sm)
  const panelRef = useRef(null)
  const inputRef = useRef(null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(null)
  const [recents, setRecents] = useState(() => readRecents(user?.id))
  const term = query.trim()
  const search = useComplaintSearch(useDebounce(term, SEARCH_DELAY_MS))

  useModalLayer({ open: true, onClose, containerRef: panelRef, initialFocusRef: inputRef })

  const isDark = resolvedTheme === 'dark'
  const quick = useMemo(
    () =>
      [
        role === 'citizen' && {
          id: 'action:report',
          kind: 'action',
          label: 'Report an issue',
          sub: 'Photo, description and location',
          icon: MapPinPlus,
          to: '/citizen/report',
          keywords: 'new complaint submit file pothole garbage',
        },
        {
          id: 'action:notifications',
          kind: 'action',
          label: 'Open notifications',
          sub: unreadCount ? null : 'You are all caught up',
          badge: unreadCount ? `${unreadCount > 99 ? '99+' : unreadCount} unread` : null,
          icon: Bell,
          to: `/${role}/notifications`,
          keywords: 'alerts updates inbox messages',
        },
        {
          id: 'action:theme',
          kind: 'action',
          label: isDark ? 'Switch to light theme' : 'Switch to dark theme',
          sub: isDark ? 'Daylight colours' : 'Night colours, easier on the eyes in the dark',
          icon: isDark ? Sun : Moon,
          keywords: 'dark light mode appearance colour color night day theme',
          // After the palette has gone, so the reveal starts from the toggle over a clear page.
          afterClose: true,
          perform: () => toggleTheme({ origin: findThemeToggle() }),
        },
      ].filter(Boolean),
    [role, unreadCount, isDark, toggleTheme],
  )

  const pages = useMemo(() => {
    const all = pageCommands(role).map((page) => ({ ...page, remember: { kind: 'page', to: page.to } }))
    const covered = new Set(quick.map((action) => action.to).filter(Boolean))
    return { all, listed: all.filter((page) => !covered.has(page.to)) }
  }, [role, quick])

  const sections = useMemo(
    () => buildSections({ role, term, recents, search, quick, pages }),
    [role, term, recents, search, quick, pages],
  )
  // Arrow keys, Enter and the highlight only ever reach rows that answer the current query.
  const options = useMemo(() => sections.flatMap((section) => section.options).filter((option) => !option.stale), [sections])
  const active = options.find((option) => option.id === activeId) ?? options[0] ?? null
  const activeDomId = active ? optionDomId(listId, active.id) : undefined

  // Keep the highlighted option in view while moving with the keyboard.
  useEffect(() => {
    if (activeDomId) document.getElementById(activeDomId)?.scrollIntoView({ block: 'nearest' })
  }, [activeDomId])

  const run = (option) => {
    if (!option) return
    if (option.kind === 'retry') {
      search.retry()
      return
    }
    if (option.remember) setRecents(rememberRecent(user?.id, option.remember))
    // The chosen row becomes the shared element of the route transition: it morphs into the page title.
    if (option.to && option.kind !== 'search') {
      document.getElementById(optionDomId(listId, option.id))?.setAttribute('data-vt-morph', option.to.split('?')[0])
    }
    onRun(option)
  }

  const move = (delta, wrap = true) => {
    if (!options.length) return
    const index = active ? options.indexOf(active) : -1
    let next = index + delta
    if (wrap) next = (next + options.length) % options.length
    else next = Math.max(0, Math.min(options.length - 1, next))
    setActiveId(options[next].id)
  }

  const handleKeyDown = (event) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'PageDown') {
      event.preventDefault()
      move(5, false)
    } else if (event.key === 'PageUp') {
      event.preventDefault()
      move(-5, false)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      run(active)
    }
  }

  const loading = term.length >= MIN_LENGTH && (search.status === 'loading' || sections.some((section) => section.searching))
  const announcement = !term
    ? ''
    : loading
      ? 'Searching complaints'
      : `${options.length} ${options.length === 1 ? 'result' : 'results'}`

  return (
    <motion.div key="palette" className="fixed inset-0 z-50" initial={{ opacity: 1 }} exit={{ opacity: 1 }}>
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-overlay backdrop-blur-[3px]"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: DURATION.base, ease: EASE.standard } }}
        exit={{ opacity: 0, transition: { duration: DURATION.fast, ease: EASE.exit } }}
      />
      <div className="pointer-events-none absolute inset-0 flex justify-center sm:items-start sm:px-6 sm:pt-[12vh]">
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Search and commands"
          tabIndex={-1}
          className={cn(
            'pointer-events-auto flex h-full w-full flex-col bg-elevated text-ink outline-hidden',
            // Desktop: one stable frame - results change inside it (the list scrolls) instead of the panel
            // snapping taller and shorter on every keystroke and again when the search answers.
            'sm:h-[min(32rem,74vh)] sm:max-w-[40rem] sm:rounded-2xl sm:border sm:border-line sm:elev-overlay',
          )}
          initial={roomy ? { opacity: 0, y: -12, scale: 0.98 } : { opacity: 0, y: 16 }}
          animate={{
            opacity: 1,
            y: 0,
            scale: 1,
            transition: { ...(roomy ? SPRING.pop : SPRING.panel), opacity: { duration: DURATION.fast, ease: EASE.standard } },
          }}
          exit={{ opacity: 0, y: roomy ? -6 : 10, scale: roomy ? 0.99 : 1, transition: { duration: DURATION.fast, ease: EASE.exit } }}
        >
          <div className="relative flex shrink-0 items-center gap-3 border-b border-line px-4 pt-[env(safe-area-inset-top)] sm:pt-0">
            <Search aria-hidden className="size-5 shrink-0 text-ink-3" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveId(null)
              }}
              onKeyDown={handleKeyDown}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeDomId}
              aria-autocomplete="list"
              aria-label="Search complaints, pages and actions"
              placeholder={roomy ? 'Search complaints, pages and actions' : 'Search complaints and pages'}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="go"
              className="h-14 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-3"
            />
            {/* Keyboard users see the Esc keycap; touch screens (phones, tablets) get a Cancel button. */}
            <Kbd aria-hidden className={cn('hidden', roomy && 'pointer-fine:inline-flex')}>
              Esc
            </Kbd>
            <button
              type="button"
              onClick={onClose}
              className={cn(
                'pressable -mr-2 min-h-11 shrink-0 rounded-lg px-2 text-sm font-semibold text-primary-ink',
                roomy && 'pointer-fine:hidden',
              )}
            >
              Cancel
            </button>
            {loading ? (
              <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
                <span className="lane-line-x animate-lane block h-full w-full" />
              </span>
            ) : null}
          </div>

          <LayoutGroup id="command-palette">
            <motion.div
              id={listId}
              role="listbox"
              aria-label="Results"
              layoutScroll
              className="scrollbar-thin min-h-0 flex-1 scroll-py-3 overflow-y-auto overscroll-contain pb-3 pt-1"
            >
              {sections.map((section) => (
                <div key={section.id} role="group" aria-labelledby={`${listId}-${section.id}`}>
                  <div id={`${listId}-${section.id}`} role="presentation" className="px-5 pb-1.5 pt-3 text-xs font-semibold text-ink-3">
                    {section.label}
                  </div>
                  {section.options.map((option) => (
                    <PaletteOption
                      key={option.id}
                      option={option}
                      domId={optionDomId(listId, option.id)}
                      active={option === active}
                      roomy={roomy}
                      onHover={() => {
                        if (option !== active) setActiveId(option.id)
                      }}
                      onRun={() => run(option)}
                    />
                  ))}
                  {section.placeholder === 'loading' ? <ComplaintSkeletons /> : null}
                  {section.placeholder === 'none' ? (
                    <p role="presentation" className="px-5 pb-1 pt-2 text-sm text-ink-3">
                      No complaints match “{term}”. Try a complaint number, a few words of the title or an area.
                    </p>
                  ) : null}
                </div>
              ))}
            </motion.div>
          </LayoutGroup>

          {roomy ? (
            <div aria-hidden className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-2.5 text-xs text-ink-3 pointer-coarse:hidden">
              <span className="inline-flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                Move
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd>
                  <CornerDownLeft className="size-3" />
                </Kbd>
                Open
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd>Esc</Kbd>
                Close
              </span>
            </div>
          ) : null}
          <p className="sr-only" aria-live="polite">
            {announcement}
          </p>
        </motion.div>
      </div>
    </motion.div>
  )
}

/**
 * Command palette (Ctrl/⌘+K) for signed-in users: jump to any page of the role, search complaints by number or
 * title through the complaints list API, run quick actions (report an issue, open notifications, switch the
 * theme) and reopen recent items. Desktop: a centred panel with keyboard hints; phones: a full-screen sheet; touch
 * screens get a Cancel button instead of the hints.
 * Rendered by CommandPaletteProvider; open it with useCommandPalette().open().
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {(command: {to?: string, perform?: () => void, afterClose?: boolean}) => void} props.onRun
 * @param {() => void} [props.onExitComplete] called once the closing animation has finished
 */
export function CommandPalette({ open, onClose, onRun, onExitComplete }) {
  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence onExitComplete={onExitComplete}>
      {open ? <PaletteDialog key="command-palette" onClose={onClose} onRun={onRun} /> : null}
    </AnimatePresence>,
    document.body,
  )
}

export default CommandPalette
