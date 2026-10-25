import { LayoutGroup, motion } from 'framer-motion'
import { LayoutDashboard, MapPinPlus, Menu } from 'lucide-react'
import { Suspense, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useLatestLocation, useScrolled } from '@/components/motion/hooks'
import { RouteTransition } from '@/components/motion/RouteTransition'
import { Stagger, StaggerItem } from '@/components/motion/Stagger'
import { SPRING } from '@/components/motion/tokens'
import { Button, Drawer, IconButton, Logo, PageLoader, ThemeToggle } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/utils/cn'
import { PUBLIC_NAV_LINKS } from './navigation'
import { RouteAnnouncer } from './RouteAnnouncer'
import { RouteViewTransitionGate } from './RouteViewTransitionGate'
import { useRouteViewTransitions } from './routeViewTransition'
import { SkipLink } from './SkipLink'

const ROLE_AREA = /^\/(citizen|officer|admin)(\/|$)/
/** Paths rendered by this layout: everything outside the role dashboards. */
const isPublicPath = (pathname) => !ROLE_AREA.test(pathname)

const isActivePath = (pathname, to) => pathname === to || pathname.startsWith(`${to}/`)

/**
 * The page area while a page is loading: the rest of the first screen under the header. `svh` (the viewport
 * with the browser's toolbars shown) keeps the loader centred in what a phone actually shows and never
 * re-lays it out as the address bar slides away. Shared with GuestRoute's session check.
 */
export const PAGE_LOADING_AREA = 'min-h-[calc(100svh-var(--public-header-h))]'

/**
 * Side gutters of the header and footer rows: 16 / 24 / 32px, and never less than the safe-area inset, so on a
 * notched phone in landscape the logo, the menu button and the links stay clear of the sensor housing.
 */
const SITE_GUTTER = 'safe-px [--safe-gutter:1rem] sm:[--safe-gutter:1.5rem] lg:[--safe-gutter:2rem]'

function SiteFooter() {
  const { isAuthenticated, homePath, role } = useAuth()
  const year = new Date().getFullYear()
  const columns = [
    {
      title: 'Platform',
      links: [
        { label: 'Features', to: '/features' },
        { label: 'How it works', to: '/how-it-works' },
        { label: 'Report an issue', to: '/citizen/report' },
      ],
    },
    {
      title: 'Organisation',
      links: [
        { label: 'About', to: '/about' },
        { label: 'Contact', to: '/contact' },
      ],
    },
    {
      title: 'Account',
      links: isAuthenticated
        ? [
            { label: 'Dashboard', to: homePath },
            { label: 'Profile', to: `/${role}/profile` },
            { label: 'Notifications', to: `/${role}/notifications` },
          ]
        : [
            { label: 'Log in', to: '/login' },
            { label: 'Create an account', to: '/register' },
          ],
    },
  ]

  return (
    // Out of the layout while <main> (its `peer/page` sibling) holds a page loader: see PublicLayout's notes.
    <footer className="no-print border-t border-line bg-surface peer-has-[[data-page-loader]]/page:hidden">
      <div className={cn('mx-auto grid max-w-7xl gap-10 py-12 md:grid-cols-[1.6fr_1fr_1fr_1fr]', SITE_GUTTER)}>
        <div>
          <Logo />
          <p className="mt-4 max-w-xs text-sm text-ink-2">
            Report civic issues with a photo, a description and your location. CivicAI classifies, prioritizes and routes
            every complaint to the right department.
          </p>
        </div>
        {columns.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h2 className="font-display text-sm font-bold text-ink">{column.title}</h2>
            {/* Touch screens: every link is a full 44px row (the rows touch, so the list keeps its rhythm). */}
            <ul className="mt-3 space-y-2 pointer-coarse:mt-1 pointer-coarse:space-y-0">
              {column.links.map((link) => (
                <li key={link.to}>
                  <Link
                    to={link.to}
                    className="group/footer inline-flex items-center rounded-sm text-sm text-ink-2 transition-colors duration-150 hover:text-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                  >
                    {/* A short lane dash slides in ahead of the hovered link. */}
                    <span
                      aria-hidden
                      className="h-0.5 w-0 rounded-full bg-marking-500 transition-[width,margin] duration-300 ease-spring group-hover/footer:mr-1.5 group-hover/footer:w-2.5"
                    />
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-line">
        <div className={cn('mx-auto flex max-w-7xl flex-col gap-2 py-5 text-xs text-ink-3 sm:flex-row sm:items-center sm:justify-between', SITE_GUTTER)}>
          <p>© {year} CivicAI. Built as a B.Tech final-year project.</p>
          <p>AI results support decisions; officers and administrators make the final call.</p>
        </div>
      </div>
    </footer>
  )
}

/**
 * Shell for the public pages (landing, features, about, contact, login, register): top navigation with the
 * logo, section links, theme picker, "Log in" and the "Report an Issue" call to action; a drawer menu below
 * lg (where the section links would have to wrap next to the buttons); and a footer with real internal
 * links. Marketing pages use a generous 16px base size. "Report an Issue" is road-marking yellow (the
 * wayfinding accent) everywhere, like the landing hero and the citizen app.
 *
 * Header contract (the landing hero depends on it):
 * - Height: `--public-header-h` (index.css, 4rem).
 * - On "/" the header is fixed and overlays the page, so the hero can start at the very top: frosted glass
 *   over the scene at the top of the page, a solid surface with a hairline and the raised elevation after
 *   8px of scroll. The page area keeps a header-high top padding until the hero marks itself with
 *   `data-hero-overlay` (then the padding drops and the hero sits under the glass header; it must offset its
 *   own content by var(--public-header-h)).
 * - Everywhere else the header is sticky in the page flow as before (no overlap) and gains the raised
 *   elevation once content scrolls under it.
 *
 * Motion: the yellow underline slides between section links (it follows the link just clicked, even while
 * that page loads); the mobile menu (a bottom sheet on phones) lists its links one after another. Page changes
 * cross-fade with the View Transitions API where available while the header stays put (routeViewTransition.js);
 * otherwise, or when the next page is not ready at once, RouteTransition gives the page a short entrance and a
 * lane-line loading bar. After each page change RouteAnnouncer moves focus to the new page's heading and
 * announces its title.
 *
 * Cold load (no layout shift): while a page's code downloads, the Suspense fallback fills the first screen
 * under the header and the footer is out of the layout (it follows `<main>`, the `peer/page`, and hides while
 * `<main>` holds a `[data-page-loader]` - CSS only). Otherwise the footer would sit in view under the loader
 * and jump off-screen when the page arrives (0.12-0.33 CLS at 1440px, 0.4 at 390px). The page and the footer
 * now appear together as new boxes, which never count as a shift - also on pages shorter than the screen.
 * Later navigations keep the current page (and its footer) on screen until the next one is ready.
 */
export function PublicLayout() {
  const { isAuthenticated, role, homePath } = useAuth()
  const location = useLocation()
  const { pathname: latestPath } = useLatestLocation()
  const [menuKey, setMenuKey] = useState(null)
  const scrolled = useScrolled(8)
  const menuOpen = menuKey === location.key
  const showReport = !isAuthenticated || role === 'citizen'
  const overlay = location.pathname === '/'
  useRouteViewTransitions(isPublicPath)

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-base text-ink">
      <SkipLink />
      <header
        data-vt-part="site-header"
        data-overlay={overlay || undefined}
        data-scrolled={scrolled || undefined}
        className={cn(
          // Exactly --public-header-h tall, hairline included (border-box), so a hero offset by that height meets it.
          'no-print z-30 h-[var(--public-header-h)] border-b transition-[background-color,border-color,box-shadow] duration-300 ease-standard',
          overlay ? 'fixed inset-x-0 top-0' : 'sticky top-0',
          overlay && !scrolled && 'border-transparent bg-bg/40 backdrop-blur-md backdrop-saturate-150',
          overlay && scrolled && 'border-line bg-surface elev-raised',
          !overlay && 'border-line bg-bg/90 backdrop-blur supports-[backdrop-filter]:bg-bg/75',
          !overlay && scrolled && 'elev-raised',
        )}
      >
        <div className={cn('mx-auto flex h-full max-w-7xl items-center gap-3', SITE_GUTTER)}>
          <Link to="/" aria-label="CivicAI home" className="inline-flex shrink-0 items-center rounded-md pointer-coarse:min-h-11">
            <Logo />
          </Link>
          <LayoutGroup id="public-nav">
            <nav aria-label="Primary" className="ml-6 hidden items-center gap-1 lg:flex">
              {PUBLIC_NAV_LINKS.map((link) => {
                const active = isActivePath(latestPath, link.to)
                return (
                  <NavLink
                    key={link.to}
                    to={link.to}
                    className={cn(
                      'relative whitespace-nowrap rounded-md px-3 py-2 text-sm font-semibold transition-colors duration-150 ease-standard',
                      active ? 'text-ink' : 'text-ink-2 hover:text-ink',
                    )}
                  >
                    {link.label}
                    {active ? (
                      <motion.span
                        aria-hidden
                        layoutId="public-nav-underline"
                        transition={SPRING.indicator}
                        className="absolute inset-x-3 -bottom-[13px] h-[3px] rounded-full bg-marking-500"
                      />
                    ) : null}
                  </NavLink>
                )
              })}
            </nav>
          </LayoutGroup>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <ThemeToggle />
            {isAuthenticated ? (
              <Button variant="ghost" to={homePath} leftIcon={LayoutDashboard} className="hidden sm:inline-flex">
                Dashboard
              </Button>
            ) : (
              <Button variant="ghost" to="/login" className="hidden sm:inline-flex">
                Log in
              </Button>
            )}
            {showReport ? (
              <Button to="/citizen/report" variant="warning" leftIcon={MapPinPlus} className="hidden sm:inline-flex">
                Report an Issue
              </Button>
            ) : null}
            <IconButton
              icon={Menu}
              label="Open menu"
              className="lg:hidden"
              aria-expanded={menuOpen}
              onClick={() => setMenuKey(location.key)}
            />
          </div>
        </div>
      </header>

      <Drawer open={menuOpen} onClose={() => setMenuKey(null)} side="right" size="sm" title="Menu">
        <nav aria-label="Mobile">
          <Stagger as="ul" className="flex flex-col gap-1" y={8} step={0.04}>
            {PUBLIC_NAV_LINKS.map((link, index) => (
              <StaggerItem as="li" key={link.to} index={index}>
                <NavLink
                  to={link.to}
                  className={({ isActive }) =>
                    cn(
                      'flex min-h-11 items-center rounded-lg px-3 text-base font-semibold transition-colors',
                      isActive ? 'bg-primary-soft text-primary-ink' : 'text-ink hover:bg-sunken',
                    )
                  }
                >
                  {link.label}
                </NavLink>
              </StaggerItem>
            ))}
          </Stagger>
        </nav>
        <div className="mt-6 flex flex-col gap-2 border-t border-line pt-6">
          {showReport ? (
            <Button to="/citizen/report" variant="warning" leftIcon={MapPinPlus} size="lg" fullWidth>
              Report an Issue
            </Button>
          ) : null}
          {isAuthenticated ? (
            <Button variant="outline" to={homePath} leftIcon={LayoutDashboard} size="lg" fullWidth>
              Dashboard
            </Button>
          ) : (
            <>
              <Button variant="outline" to="/login" size="lg" fullWidth>
                Log in
              </Button>
              <Button variant="ghost" to="/register" size="lg" fullWidth>
                Create an account
              </Button>
            </>
          )}
        </div>
      </Drawer>

      <main
        id="main-content"
        tabIndex={-1}
        className={cn(
          // Pages bring their own gutters; on a notched phone in landscape the content still clears the insets.
          'peer/page safe-px flex-1 outline-hidden [--safe-gutter:0px]',
          overlay && 'pt-[var(--public-header-h)] has-[[data-hero-overlay]]:pt-0',
        )}
      >
        <Suspense fallback={<PageLoader className={PAGE_LOADING_AREA} />}>
          <RouteViewTransitionGate />
          <RouteTransition>
            <Outlet />
          </RouteTransition>
        </Suspense>
      </main>
      <SiteFooter />
      <RouteAnnouncer />
    </div>
  )
}

export default PublicLayout
