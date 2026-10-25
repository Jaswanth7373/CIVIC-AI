import { ChevronRight, Menu, Search } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useScrolled } from '@/components/motion/hooks'
import { DemoModeBadge, IconButton, LogoMark, ThemeToggle } from '@/components/ui'
import { FIELD_BASE } from '@/components/ui/fieldStyles'
import { Kbd } from '@/components/ui/Kbd'
import { useAuth } from '@/hooks/useAuth'
import { useCommandPalette } from '@/hooks/useCommandPalette'
import { cn } from '@/utils/cn'
import { ROLE_PORTAL_LABELS, findActiveNavItem } from './navigation'
import { NotificationBell } from './NotificationBell'
import { UserMenu } from './UserMenu'

/** "Ctrl K" -> ["Ctrl", "K"]; "⌘K" -> ["⌘", "K"]: one keycap per key. */
function ShortcutKeys({ shortcut, className }) {
  const keys = shortcut.includes(' ') ? shortcut.split(' ') : [shortcut.slice(0, -1), shortcut.slice(-1)]
  return (
    <span aria-hidden className={cn('flex items-center gap-1', className)}>
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  )
}

/** aria-keyshortcuts value for the palette: "Control+K" or "Meta+K". */
const ariaShortcut = (shortcut) => (shortcut.startsWith('⌘') ? 'Meta+K' : 'Control+K')

/**
 * Complaint search: submits to the role's complaint list with `?search=` (officers and admins). A keycap hint at
 * its right edge opens the command palette, which searches as you type.
 */
function ComplaintSearch({ role, className }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const palette = useCommandPalette()
  const listPath = `/${role}/complaints`
  const initial = location.pathname === listPath ? (searchParams.get('search') ?? '') : ''
  const [term, setTerm] = useState(initial)

  const submit = (event) => {
    event.preventDefault()
    const query = term.trim()
    navigate(query ? `${listPath}?search=${encodeURIComponent(query)}` : listPath)
  }

  return (
    <form role="search" onSubmit={submit} className={cn('relative', className)}>
      <label htmlFor="topbar-search-desktop" className="sr-only">
        Search complaints
      </label>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
      <input
        id="topbar-search-desktop"
        type="search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Search number, title or area"
        enterKeyHint="search"
        autoComplete="off"
        className={cn(FIELD_BASE, 'h-10 bg-surface-2 pl-9 pr-3 pointer-coarse:h-11', palette.available && 'pointer-fine:pr-[4.75rem]')}
      />
      {palette.available ? (
        <button
          type="button"
          onClick={palette.open}
          aria-label="Open search and commands"
          aria-haspopup="dialog"
          aria-keyshortcuts={ariaShortcut(palette.shortcut)}
          title={`Search and commands (${palette.shortcut})`}
          className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded-md p-1 transition-colors duration-150 hover:bg-sunken pointer-fine:flex"
        >
          <ShortcutKeys shortcut={palette.shortcut} />
        </button>
      ) : null}
    </form>
  )
}

/**
 * Citizens have no search box in the bar: from laptop width a search field-like button opens the command palette
 * (search their complaints, jump to a page, report an issue); below that (where the breadcrumb needs the room) an
 * icon button does.
 */
function PaletteButton({ className }) {
  const palette = useCommandPalette()
  if (!palette.available) return null
  return (
    <button
      type="button"
      onClick={palette.open}
      aria-haspopup="dialog"
      aria-keyshortcuts={ariaShortcut(palette.shortcut)}
      className={cn(
        'group h-10 min-w-0 items-center gap-2 rounded-lg border border-line-strong bg-surface-2 pl-3 pr-1.5 text-left text-sm text-ink-3',
        'transition-[border-color,background-color] duration-150 ease-standard hover:border-ink-3 pointer-coarse:h-11',
        className,
      )}
    >
      <Search aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Search or jump to</span>
      <ShortcutKeys shortcut={palette.shortcut} className="pointer-coarse:hidden" />
    </button>
  )
}

/**
 * Where we are: "<group> > <page>". With the complaint search in the bar (officers, admins) the crumb needs the
 * room of a laptop screen - from lg the page label, from xl the group as well; without it (citizens) it shows
 * from sm / md. Below that the page heading names the page, so nothing is cut into fragments ("Op... > All...").
 * A path that is not in the navigation (e.g. a mistyped URL) shows only the portal name, never a wrong page.
 */
function Breadcrumb({ role, active, roomy }) {
  const portal = ROLE_PORTAL_LABELS[role]
  return (
    <div className={cn('ml-1 hidden min-w-0 flex-1 items-center gap-1.5 lg:ml-0', roomy ? 'sm:flex' : 'lg:flex')}>
      {active ? (
        <>
          <span className={cn('hidden truncate text-sm text-ink-3', roomy ? 'md:inline' : 'xl:inline')}>{active.group ?? portal}</span>
          <ChevronRight aria-hidden className={cn('hidden size-3.5 shrink-0 text-ink-3', roomy ? 'md:block' : 'xl:block')} />
          <span className="truncate font-display text-[15px] font-bold text-ink">{active.item.label}</span>
        </>
      ) : (
        <span className="truncate font-display text-[15px] font-bold text-ink">{portal}</span>
      )}
    </div>
  )
}

/**
 * Dashboard top bar: menu button (below lg), current section title, search (the complaint search box for
 * officers and admins, a "Search or jump to" button for citizens - both lead to the command palette, Ctrl/⌘+K),
 * Demo AI Mode badge, theme picker, notification bell and the account menu. On phones the bar has no room for
 * the badge text, so DashboardLayout shows the Demo AI Mode strip under it instead, and search is an icon that
 * opens the palette full screen.
 *
 * Glass on scroll: at the top of a page the bar is flush with the page (same colour, no rule), so the page
 * heading leads; once content scrolls under it, it turns into frosted glass with a hairline and the
 * "raised" elevation. Only the threshold crossing re-renders it, not every scroll event.
 * During a route view transition the bar is captured on its own (`data-vt-part="topbar"`) and stays put.
 *
 * @param {{onMenuClick: () => void}} props
 */
export function Topbar({ onMenuClick }) {
  const { role, homePath } = useAuth()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const palette = useCommandPalette()
  const active = findActiveNavItem(role, location.pathname)
  const scrolled = useScrolled(4)
  const canSearch = role === 'officer' || role === 'admin'
  // Re-mount the search box when the list's ?search= changes, so its text always matches the list it filters.
  const searchKey = location.pathname === `/${role}/complaints` ? (searchParams.get('search') ?? '') : ''

  return (
    <header
      data-vt-part="topbar"
      data-scrolled={scrolled || undefined}
      className={cn(
        'no-print sticky top-0 z-30 border-b transition-[background-color,border-color,box-shadow] duration-300 ease-standard',
        scrolled
          ? 'border-line bg-surface/95 elev-raised backdrop-blur-xl backdrop-saturate-150 supports-[backdrop-filter]:bg-surface/75'
          : 'border-transparent bg-bg',
      )}
    >
      {/* safe-px: the gutters never fall inside a landscape phone's notch / rounded-corner inset (index.css). */}
      <div className="safe-px flex h-16 items-center gap-1.5 [--safe-gutter:0.75rem] sm:gap-2 sm:[--safe-gutter:1.25rem] lg:[--safe-gutter:1.5rem]">
        <IconButton icon={Menu} label="Open navigation" onClick={onMenuClick} className="lg:hidden" />
        <Link
          to={homePath}
          aria-label="CivicAI dashboard"
          className="grid shrink-0 place-items-center rounded-md lg:hidden pointer-coarse:size-11"
        >
          <LogoMark size={28} />
        </Link>

        <Breadcrumb role={role} active={active} roomy={!canSearch} />
        <div className={cn('flex-1', canSearch ? 'lg:hidden' : 'sm:hidden')} />

        {canSearch ? <ComplaintSearch key={searchKey} role={role} className="hidden w-64 md:block xl:w-80" /> : null}
        {!canSearch ? <PaletteButton className="hidden w-52 lg:flex xl:w-64" /> : null}
        {palette.available ? (
          <IconButton
            icon={Search}
            label={canSearch ? 'Search complaints' : 'Search and commands'}
            className={canSearch ? 'md:hidden' : 'lg:hidden'}
            aria-haspopup="dialog"
            aria-keyshortcuts={ariaShortcut(palette.shortcut)}
            onClick={palette.open}
          />
        ) : null}
        <div className="hidden sm:contents">
          <DemoModeBadge />
        </div>
        <ThemeToggle />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  )
}

export default Topbar
