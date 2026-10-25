/**
 * Navigation structure for the public site and the three role dashboards (BUILD_SPEC 5.5).
 * The Sidebar, Topbar title and MobileTabBar all read from here, so a route is renamed in one place.
 * `badge: 'notifications'` shows the unread notification count on that item.
 */
import {
  Bell,
  BrainCircuit,
  Building2,
  CircleUserRound,
  ClipboardList,
  Copy,
  FileText,
  HardHat,
  LayoutDashboard,
  MapPinned,
  MapPinPlus,
  MessageSquareText,
  ScrollText,
  Settings,
  Star,
  Users,
} from 'lucide-react'

export const PUBLIC_NAV_LINKS = Object.freeze([
  { label: 'Features', to: '/features' },
  { label: 'How it works', to: '/how-it-works' },
  { label: 'About', to: '/about' },
  { label: 'Contact', to: '/contact' },
])

const account = (role) => ({
  label: 'Account',
  items: [
    { label: 'Notifications', to: `/${role}/notifications`, icon: Bell, badge: 'notifications' },
    { label: 'Profile', to: `/${role}/profile`, icon: CircleUserRound },
  ],
})

/** Sidebar groups per role. Groups without a label render as a plain list. */
export const NAVIGATION = Object.freeze({
  citizen: [
    {
      label: null,
      items: [
        { label: 'Dashboard', to: '/citizen/dashboard', icon: LayoutDashboard },
        { label: 'Report an issue', to: '/citizen/report', icon: MapPinPlus },
        { label: 'My complaints', to: '/citizen/complaints', icon: ClipboardList },
        { label: 'Feedback', to: '/citizen/feedback', icon: Star },
        { label: 'Notifications', to: '/citizen/notifications', icon: Bell, badge: 'notifications' },
        { label: 'Profile', to: '/citizen/profile', icon: CircleUserRound },
      ],
    },
  ],
  officer: [
    {
      label: null,
      items: [
        { label: 'Dashboard', to: '/officer/dashboard', icon: LayoutDashboard },
        { label: 'Assigned complaints', to: '/officer/complaints', icon: ClipboardList },
        { label: 'Notifications', to: '/officer/notifications', icon: Bell, badge: 'notifications' },
        { label: 'Profile', to: '/officer/profile', icon: CircleUserRound },
      ],
    },
  ],
  admin: [
    { label: 'Overview', items: [{ label: 'Dashboard', to: '/admin/dashboard', icon: LayoutDashboard }] },
    {
      label: 'Operations',
      items: [
        { label: 'All complaints', to: '/admin/complaints', icon: ClipboardList },
        { label: 'Duplicates', to: '/admin/duplicates', icon: Copy },
        { label: 'Hotspot map', to: '/admin/hotspots', icon: MapPinned },
      ],
    },
    {
      label: 'People',
      items: [
        { label: 'Users', to: '/admin/users', icon: Users },
        { label: 'Officers', to: '/admin/officers', icon: HardHat },
      ],
    },
    {
      label: 'Organisation',
      items: [{ label: 'Departments & categories', to: '/admin/departments', icon: Building2 }],
    },
    {
      label: 'Insights',
      items: [
        { label: 'AI analytics', to: '/admin/ai-analytics', icon: BrainCircuit },
        { label: 'Feedback analytics', to: '/admin/feedback', icon: MessageSquareText },
        { label: 'Reports', to: '/admin/reports', icon: FileText },
      ],
    },
    {
      label: 'System',
      items: [
        { label: 'Settings', to: '/admin/settings', icon: Settings },
        { label: 'Audit logs', to: '/admin/audit-logs', icon: ScrollText },
      ],
    },
    account('admin'),
  ],
})

export const ROLE_PORTAL_LABELS = Object.freeze({
  citizen: 'Citizen portal',
  officer: 'Officer workspace',
  admin: 'Administration',
})

/**
 * The nav item that owns `pathname` (exact match or a sub-path, e.g. /admin/complaints/12 -> "All complaints"),
 * with its group label. Returns null when nothing matches.
 */
export function findActiveNavItem(role, pathname = '') {
  let best = null
  for (const group of NAVIGATION[role] ?? []) {
    for (const item of group.items) {
      const matches = pathname === item.to || pathname.startsWith(`${item.to}/`)
      if (matches && (!best || item.to.length > best.item.to.length)) best = { group: group.label, item }
    }
  }
  return best
}
