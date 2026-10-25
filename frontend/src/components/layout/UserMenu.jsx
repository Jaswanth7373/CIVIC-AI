import { Bell, ChevronDown, CircleUserRound, LogOut } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Avatar, Badge, DropdownMenu } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { ROLE_LABELS } from '@/utils/constants'

// Civic-signage tones only, matching the profile and user screens: asphalt for citizens and officers, sign green for admins.
const ROLE_TONES = { citizen: 'neutral', officer: 'neutral', admin: 'green' }

/** Account menu in the topbar: who is signed in, links to profile and notifications, and log out. */
export function UserMenu() {
  const { user, role, logout } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  if (!user) return null

  const handleLogout = async () => {
    await logout()
    toast.info('Logged out', 'See you soon.')
    navigate('/login', { replace: true })
  }

  return (
    <DropdownMenu
      label="Account"
      align="end"
      header={
        <div className="flex items-center gap-3">
          <Avatar src={user.avatar} name={user.full_name} size="md" decorative />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{user.full_name}</p>
            <p className="truncate text-xs text-ink-3">{user.email}</p>
            <Badge size="sm" tone={ROLE_TONES[role] ?? 'neutral'} className="mt-1">
              {ROLE_LABELS[role] ?? role}
            </Badge>
          </div>
        </div>
      }
      items={[
        { label: 'Profile', icon: CircleUserRound, to: `/${role}/profile` },
        { label: 'Notifications', icon: Bell, to: `/${role}/notifications` },
        { divider: true },
        { label: 'Log out', icon: LogOut, danger: true, onClick: handleLogout },
      ]}
      trigger={
        <button
          type="button"
          aria-label={`Account menu, signed in as ${user.full_name}`}
          className="pressable flex items-center justify-center gap-2 rounded-lg p-1 [--press-scale:0.96] hover:bg-sunken pointer-coarse:min-h-11 pointer-coarse:min-w-11 xl:pr-2"
        >
          <Avatar src={user.avatar} name={user.full_name} size="sm" decorative />
          <span className="hidden max-w-32 truncate text-sm font-semibold text-ink xl:block">{user.first_name || user.full_name}</span>
          <ChevronDown aria-hidden className="hidden size-4 text-ink-3 xl:block" />
        </button>
      }
    />
  )
}

export default UserMenu
