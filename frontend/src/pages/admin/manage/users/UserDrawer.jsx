/**
 * UserDrawer - one account in detail: profile, role-specific profile (citizen address / officer assignment),
 * activity numbers, and the activate / deactivate action.
 *
 * Props:
 * - open, onClose
 * - user: AdminUserSerializer row from GET /users/ (`citizen_profile`, `officer_profile`, `stats`,
 *   `complaint_count`, `civic_points`)
 * - isSelf: the signed-in administrator (cannot deactivate their own account)
 * - onToggleActive(user): asks for confirmation and calls the API (owned by the page)
 * - busy: the toggle is running
 */
import { ClipboardList, HardHat, Power, PowerOff } from 'lucide-react'
import { DepartmentBadge } from '@/components/complaints'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/components/ui/Drawer'
import { KeyValueList } from '@/components/ui/KeyValueList'
import { GENDER_OPTIONS } from '@/utils/constants'
import { formatDate, formatDateTime, formatNumber, timeAgo } from '@/utils/format'
import { LANGUAGE_LABELS, complaintCountLabel, getRoleMeta } from './userMeta'

function Stat({ label, value }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-2 px-3 py-2.5">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="mt-0.5 font-display text-xl font-extrabold text-ink tabular">{value}</p>
    </div>
  )
}

function Heading({ children }) {
  return <h3 className="mb-3 text-sm font-bold text-ink">{children}</h3>
}

export function UserDrawer({ open, onClose, user, isSelf = false, onToggleActive, busy = false }) {
  if (!user) return <Drawer open={false} onClose={onClose} title="User" />
  const role = getRoleMeta(user.role)
  const citizen = user.citizen_profile
  const officer = user.officer_profile
  const complaints = user.complaint_count ?? user.stats?.complaints ?? 0
  const gender = GENDER_OPTIONS.find((option) => option.value === citizen?.gender)?.label
  // Only the details the citizen actually filled in (empty ones would read as a column of dashes).
  const citizenDetails = citizen
    ? [
        { label: 'Address', value: citizen.address, fullWidth: true },
        { label: 'Area', value: citizen.area },
        { label: 'City', value: citizen.city },
        { label: 'PIN code', value: citizen.pincode ? <span className="tabular">{citizen.pincode}</span> : null },
        { label: 'Date of birth', value: citizen.date_of_birth ? formatDate(citizen.date_of_birth) : null },
        { label: 'Gender', value: gender },
      ].filter((item) => item.value)
    : []
  const complaintsLink =
    user.role === 'officer' ? `/admin/complaints?assigned_officer=${user.id}` : `/admin/complaints?citizen=${user.id}`

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      size="lg"
      title="Account details"
      description={user.email}
      footer={
        <>
          {complaints > 0 ? (
            <Button variant="ghost" to={complaintsLink} leftIcon={ClipboardList}>
              View complaints
            </Button>
          ) : null}
          {user.is_active ? (
            <Button variant="danger" leftIcon={PowerOff} disabled={isSelf} loading={busy} onClick={() => onToggleActive?.(user)}>
              Deactivate account
            </Button>
          ) : (
            <Button leftIcon={Power} loading={busy} onClick={() => onToggleActive?.(user)}>
              Activate account
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Avatar src={user.avatar} name={user.full_name} size="lg" decorative />
          <div className="min-w-0">
            <p className="font-display text-lg font-bold text-ink">{user.full_name || user.email}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge tone={role.tone} icon={role.icon} size="sm">
                {role.label}
              </Badge>
              <Badge tone={user.is_active ? 'green' : 'neutral'} size="sm" dot>
                {user.is_active ? 'Active' : 'Deactivated'}
              </Badge>
              {isSelf ? (
                <Badge tone="slate" size="sm">
                  You
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
        {isSelf ? <p className="-mt-3 text-xs text-ink-3">You cannot deactivate the account you are signed in with.</p> : null}

        <div className="grid grid-cols-2 gap-2">
          <Stat label={complaintCountLabel(user.role)} value={formatNumber(complaints)} />
          {user.role === 'citizen' ? (
            <Stat label="Civic points" value={formatNumber(user.civic_points ?? user.stats?.civic_points ?? 0)} />
          ) : officer ? (
            <Stat label="Open workload" value={`${formatNumber(officer.active_workload ?? 0)}/${formatNumber(officer.max_active_complaints)}`} />
          ) : (
            <Stat label="Joined" value={formatDate(user.date_joined, 'MMM yyyy')} />
          )}
        </div>

        <section>
          <Heading>Account</Heading>
          <KeyValueList
            columns={2}
            items={[
              { label: 'Email', value: <a href={`mailto:${user.email}`} className="break-all text-primary-ink hover:underline">{user.email}</a> },
              { label: 'Phone', value: user.phone ? <a href={`tel:${user.phone}`} className="text-primary-ink hover:underline tabular">{user.phone}</a> : null },
              { label: 'Joined', value: <time dateTime={user.date_joined} className="tabular">{formatDateTime(user.date_joined)}</time> },
              {
                label: 'Last login',
                value: user.last_login ? (
                  <time dateTime={user.last_login} title={formatDateTime(user.last_login)}>
                    {timeAgo(user.last_login)}
                  </time>
                ) : (
                  'Never'
                ),
              },
            ]}
          />
        </section>

        {citizen ? (
          <section>
            <Heading>Citizen profile</Heading>
            {citizenDetails.length ? null : (
              <p className="mb-3 text-sm text-ink-3">No address or personal details added yet.</p>
            )}
            <KeyValueList
              columns={2}
              items={[
                ...citizenDetails,
                { label: 'Language', value: LANGUAGE_LABELS[citizen.preferred_language] ?? citizen.preferred_language },
                { label: 'Email updates', value: citizen.email_notifications ? 'On' : 'Off' },
              ]}
            />
          </section>
        ) : null}

        {officer ? (
          <section>
            <Heading>Officer profile</Heading>
            <KeyValueList
              columns={2}
              items={[
                { label: 'Department', value: officer.department ? <DepartmentBadge department={officer.department} size="sm" /> : 'No department' },
                { label: 'Employee id', value: officer.employee_id ? <span className="tabular">{officer.employee_id}</span> : null },
                { label: 'Designation', value: officer.designation },
                { label: 'Zone', value: officer.zone },
                { label: 'Availability', value: officer.is_available ? 'Available for new work' : 'Unavailable' },
                { label: 'Joined the department', value: officer.joined_on ? formatDate(officer.joined_on) : null },
              ]}
            />
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              leftIcon={HardHat}
              to={`/admin/officers?search=${encodeURIComponent(user.email)}`}
            >
              Open in officer management
            </Button>
          </section>
        ) : null}
      </div>
    </Drawer>
  )
}

export default UserDrawer
