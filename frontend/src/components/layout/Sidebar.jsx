import { LayoutGroup, motion } from 'framer-motion'
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { Link, NavLink } from 'react-router-dom'
import { useLatestLocation } from '@/components/motion/hooks'
import { SPRING } from '@/components/motion/tokens'
import { Avatar, IconButton, Logo, Tooltip } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { useNotifications } from '@/hooks/useNotifications'
import { useScrollEdges } from '@/hooks/useScrollEdges'
import { cn } from '@/utils/cn'
import { ROLE_LABELS } from '@/utils/constants'
import { NAVIGATION, findActiveNavItem } from './navigation'

const SIDEBAR_BUTTON = 'text-asphalt-300 hover:bg-sidebar-2 hover:text-white'

/** Fade at the top / bottom of the nav while more items are scrolled out of view there. */
function NavFade({ side }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-x-0 z-10 h-8 from-sidebar to-transparent',
        side === 'start' ? 'top-0 bg-linear-to-b' : 'bottom-0 bg-linear-to-t',
      )}
    />
  )
}

function SidebarLink({ item, active, collapsed, badgeCount, onNavigate }) {
  const Icon = item.icon
  const badge = item.badge === 'notifications' ? badgeCount : 0
  const link = (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      aria-label={collapsed ? (badge ? `${item.label}, ${badge} unread` : item.label) : undefined}
      className={cn(
        'group relative flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-standard pointer-coarse:min-h-11',
        active ? 'text-white' : 'text-asphalt-300 hover:bg-sidebar-2/60 hover:text-white',
        collapsed && 'justify-center px-0',
      )}
    >
      {active ? (
        <>
          {/* Both slide to the clicked item (shared layout, scoped to this sidebar by its LayoutGroup). The pill
              sits on layer 0 and every label / icon on layer 1, so while it travels it passes UNDER the other
              items instead of covering them. */}
          <motion.span
            aria-hidden
            layoutId="sidebar-active-pill"
            transition={SPRING.indicator}
            style={{ borderRadius: 10 }}
            className="absolute inset-0 z-0 bg-sidebar-2 bg-[image:linear-gradient(90deg,rgb(245_183_0/0.1),transparent_58%)] shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]"
          />
          <motion.span
            aria-hidden
            layoutId="sidebar-active-lane"
            transition={SPRING.indicator}
            className="lane-line absolute -left-3 top-1/2 -mt-3.5 h-7 w-[3px] rounded-full"
          />
        </>
      ) : null}
      <Icon
        aria-hidden
        className={cn(
          'relative z-[1] size-[18px] shrink-0 transition-colors duration-150',
          active ? 'text-marking-400' : 'text-asphalt-400 group-hover:text-asphalt-200',
        )}
      />
      {!collapsed ? <span className="relative z-[1] min-w-0 flex-1 truncate">{item.label}</span> : null}
      {badge > 0 ? (
        collapsed ? (
          <span aria-hidden className="absolute right-2.5 top-1.5 z-[1] size-2 rounded-full bg-signal-500 ring-2 ring-sidebar" />
        ) : (
          <span className="relative z-[1] rounded-full bg-signal-500 px-1.5 py-px text-[11px] font-bold text-white tabular">
            <span className="sr-only">, </span>
            {badge > 99 ? '99+' : badge}
            <span className="sr-only"> unread</span>
          </span>
        )
      ) : null}
    </NavLink>
  )
  return collapsed ? (
    <Tooltip content={item.label} side="right" className="w-full">
      {link}
    </Tooltip>
  ) : (
    link
  )
}

/**
 * Dashboard navigation on asphalt: role-specific groups from navigation.js, the active item marked by a
 * short dashed yellow lane line, unread notification count, and the signed-in user.
 * Rhythm: 32px items and tight group spacing, so the longest list (administrators: 14 items in 7 groups) fits a
 * 900px tall laptop screen; on shorter screens the list scrolls and a fade at its edge shows that there is more.
 *
 * Motion: the active pill (lit by a faint sodium glow from the lane marker) and the lane marker slide to the
 * clicked item on a critically damped spring. They follow the location being navigated to, so they move the
 * moment a link is clicked, even while the next page is still loading (`aria-current` keeps describing the
 * page on screen). The rail and the drawer animate independently (separate layout groups).
 *
 * @param {object} props
 * @param {'rail'|'drawer'} [props.variant='rail'] `rail` = persistent desktop sidebar, `drawer` = mobile panel
 * @param {boolean} [props.collapsed] icon-only rail (desktop)
 * @param {() => void} [props.onToggleCollapse] desktop collapse button
 * @param {() => void} [props.onNavigate] called after a link is followed (closes the mobile drawer)
 * @param {() => void} [props.onClose] mobile drawer close button
 */
export function Sidebar({ variant = 'rail', collapsed = false, onToggleCollapse, onNavigate, onClose, className }) {
  const { user, role, homePath } = useAuth()
  const { unreadCount } = useNotifications()
  const { pathname } = useLatestLocation()
  const groups = NAVIGATION[role] ?? []
  const activeTo = findActiveNavItem(role, pathname)?.item.to
  const isCollapsed = variant === 'rail' && collapsed
  const [navRef, navEdges] = useScrollEdges({ axis: 'y' })

  return (
    <div
      className={cn(
        // A hairline of light along the right edge: on the night theme the asphalt sidebar would otherwise melt
        // into the page (on the day theme it is invisible against the light page).
        'flex h-full flex-col bg-sidebar text-asphalt-300 shadow-[inset_-1px_0_0_rgb(255_255_255/0.055)]',
        className,
      )}
    >
      <div className={cn('flex h-16 shrink-0 items-center gap-2 border-b border-white/5', isCollapsed ? 'justify-center px-2' : 'px-5')}>
        <Link
          to={homePath}
          onClick={onNavigate}
          className="inline-flex items-center rounded-md pointer-coarse:min-h-11"
          aria-label="CivicAI dashboard"
        >
          <Logo tone="inverse" variant={isCollapsed ? 'mark' : 'full'} size={isCollapsed ? 'sm' : 'md'} />
        </Link>
        {variant === 'drawer' ? (
          <IconButton icon={X} label="Close navigation" onClick={onClose} className={cn('ml-auto', SIDEBAR_BUTTON)} />
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1">
        <LayoutGroup id={`sidebar-${variant}`}>
          <motion.nav
            ref={navRef}
            layoutScroll
            aria-label="Main navigation"
            // In the phone drawer a sideways swipe closes the drawer, so only vertical pans scroll the list.
            className={cn('scrollbar-thin h-full overflow-y-auto px-3 py-3', variant === 'drawer' && 'touch-pan-y')}
          >
            {groups.map((group, index) => (
              <div key={group.label ?? index} className={cn(index > 0 && 'mt-3')}>
                {group.label && !isCollapsed ? (
                  <p className="px-3 pb-1 text-xs font-semibold text-asphalt-400">{group.label}</p>
                ) : null}
                {group.label && isCollapsed && index > 0 ? <div aria-hidden className="mx-auto mb-3 h-px w-8 bg-white/10" /> : null}
                <ul className="space-y-0.5">
                  {group.items.map((item) => (
                    <li key={item.to}>
                      <SidebarLink
                        item={item}
                        active={item.to === activeTo}
                        collapsed={isCollapsed}
                        badgeCount={unreadCount}
                        onNavigate={onNavigate}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </motion.nav>
        </LayoutGroup>
        {navEdges.start ? <NavFade side="start" /> : null}
        {navEdges.end ? <NavFade side="end" /> : null}
      </div>

      <div className={cn('flex shrink-0 items-center gap-2 border-t border-white/5 p-3', isCollapsed && 'justify-center px-2')}>
        {user && !isCollapsed ? (
          <div className="flex min-w-0 flex-1 items-center gap-3 px-2 py-1">
            <Avatar src={user.avatar} name={user.full_name} size="sm" decorative />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{user.full_name}</p>
              <p className="truncate text-xs text-asphalt-400">{ROLE_LABELS[role] ?? role}</p>
            </div>
          </div>
        ) : null}
        {variant === 'rail' && onToggleCollapse ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!isCollapsed}
            className={cn('pressable grid size-9 shrink-0 place-items-center rounded-lg [--press-scale:0.9] pointer-coarse:size-11', SIDEBAR_BUTTON)}
          >
            {isCollapsed ? <PanelLeftOpen aria-hidden className="size-[18px]" /> : <PanelLeftClose aria-hidden className="size-[18px]" />}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export default Sidebar
