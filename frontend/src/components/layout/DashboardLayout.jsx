import { Suspense, useCallback, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { CommandPaletteProvider } from '@/components/command/CommandPaletteProvider'
import { RouteTransition } from '@/components/motion/RouteTransition'
import { DemoModeBadge, Drawer, PageLoader } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/utils/cn'
import { STORAGE_KEYS, storage } from '@/utils/storage'
import { MobileTabBar } from './MobileTabBar'
import { RouteAnnouncer } from './RouteAnnouncer'
import { RouteViewTransitionGate } from './RouteViewTransitionGate'
import { useRouteViewTransitions } from './routeViewTransition'
import { Sidebar } from './Sidebar'
import { SkipLink } from './SkipLink'
import { Topbar } from './Topbar'

/**
 * Shell for the citizen, officer and admin areas (dense 14px base type).
 * - lg and up: persistent asphalt sidebar, collapsible to an icon rail (choice remembered in localStorage).
 * - Below lg: the sidebar opens as an off-canvas drawer from the topbar menu button (swipe it back to close).
 *   The drawer is "open for the location it was opened on", so any navigation (link, back button) closes it
 *   without an effect.
 * - Citizens on phones also get the bottom tab bar; the content leaves room for it.
 * - Phones show the "Demo AI Mode" strip at the top of every page, under the top bar (whose badge has no room
 *   for its text there). It scrolls with the page, so the sticky bar stays 64px tall for sticky page headings.
 *   Its line is held while the first config request is out, so a late answer never pushes the page down.
 * - The command palette (Ctrl/⌘+K, or the topbar search) is available on every page of the shell.
 *
 * Page changes: where the View Transitions API exists, moving between pages of the area cross-fades the content
 * with a little depth while the sidebar, top bar and tab bar stay put (routeViewTransition.js); otherwise - and
 * whenever the next page is not ready at once - RouteTransition gives the new page its short entrance and runs
 * the lane-line progress bar while the next page's code downloads (the current page stays until it is ready).
 * Pages render in <Outlet /> inside a Suspense boundary, so the shell stays in place while a lazy page loads.
 * After each page change RouteAnnouncer moves focus to the new page's heading and announces its title.
 * Notched phones in landscape: the page gutters grow to the safe-area insets (`safe-px`, index.css).
 */
export function DashboardLayout() {
  const { role } = useAuth()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(() => storage.get(STORAGE_KEYS.sidebar) === 'collapsed')
  const [drawerKey, setDrawerKey] = useState(null)
  const drawerOpen = drawerKey === location.key
  const isCitizen = role === 'citizen'

  const isInArea = useCallback((pathname) => pathname === `/${role}` || pathname.startsWith(`/${role}/`), [role])
  useRouteViewTransitions(isInArea)

  const toggleCollapsed = () => {
    const next = !collapsed
    storage.set(STORAGE_KEYS.sidebar, next ? 'collapsed' : 'expanded')
    setCollapsed(next)
  }
  const closeDrawer = () => setDrawerKey(null)

  return (
    <CommandPaletteProvider>
      <div className="min-h-dvh bg-bg text-sm text-ink">
        <SkipLink />
        <aside
          data-vt-part="sidebar"
          className={cn(
            'no-print fixed inset-y-0 left-0 z-40 hidden transition-[width] duration-300 ease-standard lg:block',
            collapsed ? 'w-[76px]' : 'w-64',
          )}
        >
          <Sidebar collapsed={collapsed} onToggleCollapse={toggleCollapsed} />
        </aside>

        <Drawer
          open={drawerOpen}
          onClose={closeDrawer}
          side="left"
          size="sm"
          hideHeader
          aria-label="Navigation"
          className="border-r-0 bg-sidebar"
        >
          <Sidebar variant="drawer" onNavigate={closeDrawer} onClose={closeDrawer} />
        </Drawer>

        <div
          className={cn(
            'flex min-h-dvh min-w-0 flex-col transition-[padding] duration-300 ease-standard',
            collapsed ? 'lg:pl-[76px]' : 'lg:pl-64',
            // The sidebar is not printed, so its space is not reserved on paper either.
            'print:min-h-0 print:pl-0',
          )}
        >
          <Topbar onMenuClick={() => setDrawerKey(location.key)} />
          <DemoModeBadge variant="strip" reserve className="no-print sm:hidden" />
          <main
            id="main-content"
            tabIndex={-1}
            className={cn(
              // safe-px: the page gutter, never less than the notch / rounded-corner inset of a landscape phone.
              'safe-px mx-auto w-full min-w-0 max-w-[1600px] flex-1 py-5 outline-hidden [--safe-gutter:1rem] sm:py-6 sm:[--safe-gutter:1.5rem] lg:[--safe-gutter:2rem]',
              isCitizen && 'pb-28 md:pb-8',
              'print:max-w-none print:p-0 print:[--safe-gutter:0px]',
            )}
          >
            <Suspense fallback={<PageLoader variant="page" />}>
              <RouteViewTransitionGate />
              <RouteTransition>
                <Outlet />
              </RouteTransition>
            </Suspense>
          </main>
        </div>

        {isCitizen ? <MobileTabBar /> : null}
        <RouteAnnouncer />
      </div>
    </CommandPaletteProvider>
  )
}

export default DashboardLayout
