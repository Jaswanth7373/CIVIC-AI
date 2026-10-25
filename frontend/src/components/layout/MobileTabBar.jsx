import { LayoutGroup, motion } from 'framer-motion'
import { Bell, CircleUserRound, ClipboardList, House, Plus } from 'lucide-react'
import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useLatestLocation } from '@/components/motion/hooks'
import { SPRING } from '@/components/motion/tokens'
import { useNotifications } from '@/hooks/useNotifications'
import { cn } from '@/utils/cn'

const TABS = [
  { label: 'Home', to: '/citizen/dashboard', icon: House },
  { label: 'Complaints', to: '/citizen/complaints', icon: ClipboardList },
  { label: 'Report', to: '/citizen/report', icon: Plus, primary: true },
  { label: 'Alerts', to: '/citizen/notifications', icon: Bell, badge: true },
  { label: 'Profile', to: '/citizen/profile', icon: CircleUserRound },
]

const isActivePath = (pathname, to) => pathname === to || pathname.startsWith(`${to}/`)

/**
 * App-style bottom tab bar for citizens on phones (hidden from the md breakpoint up): Home, Complaints,
 * a raised yellow "Report" button in the thumb zone, Alerts (with an unread dot) and Profile.
 * Respects the iOS home-indicator safe area.
 *
 * On the report page itself the raised button settles into the bar as a flat "Report" tab (the current page,
 * marked like the others): a bigger yellow button leading to the page you are on would only compete with the
 * wizard's own Back / Continue bar. The nav then carries `data-report-fab="off"`, and the sticky action bars
 * float closer to the bar (index.css, Shell additions 2). Leaving the page, the button rises out of the bar again.
 *
 * Motion: the yellow road-marking indicator slides to the tapped tab on a spring and the tapped icon lifts,
 * the moment the tab is tapped (it follows the location being navigated to, so a page that is still
 * loading never leaves the bar looking unresponsive). Every tab squeezes slightly under the finger.
 * During a route view transition the bar is captured on its own (`data-vt-part="tabbar"`) and stays put while
 * the page cross-fades. While a text field has focus on a phone (the on-screen keyboard is up) the bar slides
 * away - on pages without a wizard / form action bar, which floats above it and stays put - so it never covers
 * the field being typed in (index.css, Shell additions 2).
 */
export function MobileTabBar() {
  const { unreadCount } = useNotifications()
  const { pathname } = useLatestLocation()
  const reporting = TABS.some((tab) => tab.primary && isActivePath(pathname, tab.to))
  // The raised button rises out of the bar only when it comes back after the report page, not on every load.
  const [fabEntrance, setFabEntrance] = useState(false)
  if (reporting && !fabEntrance) setFabEntrance(true)
  return (
    <nav
      aria-label="Quick navigation"
      data-vt-part="tabbar"
      data-report-fab={reporting ? 'off' : undefined}
      className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/90 pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_30px_-18px_rgb(15_22_23/0.35)] backdrop-blur-xl backdrop-saturate-150 md:hidden dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.04),0_-12px_32px_-16px_rgb(0_0_0/0.8)]"
    >
      <LayoutGroup id="mobile-tab-bar">
        <ul className="mx-auto grid max-w-lg grid-cols-5">
          {TABS.map((tab) => {
            const Icon = tab.icon
            const active = isActivePath(pathname, tab.to)
            if (tab.primary && !reporting) {
              return (
                // Its own key: the raised button and the flat tab never reuse each other's elements.
                <li key={`${tab.to}#raised`} className="flex justify-center">
                  <NavLink
                    to={tab.to}
                    aria-label="Report an issue"
                    // Raised 28px above the bar, so its label sits on the same line as the other tabs' labels.
                    className="group relative -mt-7 flex flex-col items-center gap-1 rounded-full px-2 text-[11px] font-semibold text-ink-2"
                  >
                    <motion.span
                      initial={fabEntrance ? { y: 22, scale: 0.6, opacity: 0 } : false}
                      animate={{ y: 0, scale: 1, opacity: 1 }}
                      transition={SPRING.pop}
                      className={cn(
                        'grid size-14 place-items-center rounded-full bg-marking-500 text-asphalt-950 shadow-[0_10px_24px_-8px_rgb(204_150_0/0.65)] ring-4 ring-surface',
                        'transition-[scale,background-color] duration-300 ease-spring-bounce group-active:scale-90',
                      )}
                    >
                      <Icon aria-hidden className="size-7" strokeWidth={2.4} />
                    </motion.span>
                    <span>{tab.label}</span>
                  </NavLink>
                </li>
              )
            }
            const showDot = tab.badge && unreadCount > 0
            return (
              <li key={tab.to}>
                <NavLink
                  to={tab.to}
                  aria-label={tab.primary ? 'Report an issue' : showDot ? `${tab.label}, ${unreadCount} unread` : undefined}
                  className={cn(
                    'group relative flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors duration-150',
                    active ? 'text-primary-ink' : 'text-ink-3 hover:text-ink',
                  )}
                >
                  {active ? (
                    <motion.span
                      aria-hidden
                      layoutId="tab-indicator"
                      transition={SPRING.indicator}
                      className="absolute top-0 h-[3px] w-7 rounded-full bg-marking-500"
                    />
                  ) : null}
                  <span
                    className={cn(
                      'relative transition-[translate,scale] duration-300 ease-spring group-active:scale-90',
                      active && '-translate-y-0.5',
                    )}
                  >
                    <Icon aria-hidden className="size-[22px]" />
                    {showDot ? (
                      <span
                        aria-hidden
                        className="absolute -right-0.5 -top-0.5 size-2.5 animate-pop-in rounded-full bg-signal-500 ring-2 ring-surface"
                      />
                    ) : null}
                  </span>
                  <span>{tab.label}</span>
                </NavLink>
              </li>
            )
          })}
        </ul>
      </LayoutGroup>
    </nav>
  )
}

export default MobileTabBar
