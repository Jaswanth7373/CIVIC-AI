/**
 * User management (admin) - every account: citizens, officers and administrators.
 *
 * Data: GET /users/ (filters `role`, `is_active`, `search`, `ordering`; paginated) with `complaint_count`
 * (reported, or assigned for officers) and `civic_points`. Filters and the page live in the URL.
 * - Row -> details drawer (profile, citizen / officer profile, numbers) with activate / deactivate.
 * - Deactivate = DELETE /users/{id}/ (soft: the account is kept, sign-in blocked, officers marked unavailable);
 *   activate = PATCH {is_active: true}. Both ask for confirmation. Nobody can deactivate their own account.
 * - "Create user" makes citizen or administrator accounts; officers are created in Officer management.
 */
import { Eye, HardHat, MoreHorizontal, Power, PowerOff, SearchX, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import {
  Badge,
  Button,
  DataTable,
  DropdownMenu,
  EmptyState,
  ErrorState,
  IconButton,
  PageHeader,
  SearchInput,
  Select,
} from '@/components/ui'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { useConfirm } from '@/hooks/useConfirm'
import { useToast } from '@/hooks/useToast'
import { userService } from '@/services'
import { getErrorMessage } from '@/utils/errors'
import { formatDate, formatDateTime, formatNumber, timeAgo } from '@/utils/format'
import { ListPagination, PersonCell, SummaryLine } from './manage/shared/Controls'
import { compactParams, toList } from './manage/shared/listUtils'
import { useUrlParams } from './manage/shared/useUrlParams'
import { CreateUserModal } from './manage/users/CreateUserModal'
import { UserDrawer } from './manage/users/UserDrawer'
import { ROLE_META, getRoleMeta } from './manage/users/userMeta'

const PAGE_SIZE = 20
const DEFAULTS = { search: '', role: '', is_active: '', ordering: '-date_joined' }
const ROLE_FILTER = [
  { value: '', label: 'All roles' },
  ...Object.values(ROLE_META).map((role) => ({ value: role.value, label: `${role.label}s` })),
]
const ACTIVE_FILTER = [
  { value: '', label: 'Any status' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Deactivated' },
]

function RoleBadge({ role }) {
  const meta = getRoleMeta(role)
  return (
    <Badge tone={meta.tone} icon={meta.icon} size="sm">
      {meta.label}
    </Badge>
  )
}

function ActiveBadge({ active }) {
  return (
    <Badge tone={active ? 'green' : 'neutral'} size="sm" dot>
      {active ? 'Active' : 'Deactivated'}
    </Badge>
  )
}

export default function UserManagement() {
  const { user: me } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const { values, setValues, page, setPage, reset } = useUrlParams(DEFAULTS)
  const [selectedId, setSelectedId] = useState(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createSession, setCreateSession] = useState(0)
  const [busyId, setBusyId] = useState(null)

  const users = useApi(() => userService.list(compactParams({ ...values, page, page_size: PAGE_SIZE })), [values, page])
  const rows = toList(users.data)
  const selected = rows.find((row) => row.id === selectedId) ?? null
  const filtered = Boolean(values.search || values.role || values.is_active)

  const openDetails = (row) => {
    setSelectedId(row.id)
    setDrawerOpen(true)
  }

  const toggleActive = async (row) => {
    const name = row.full_name || row.email
    if (row.is_active) {
      const ok = await confirm({
        title: `Deactivate ${name}?`,
        message:
          row.role === 'officer'
            ? 'They can no longer sign in and are marked unavailable, so no new complaints are assigned to them. Their history stays; reassign their open complaints.'
            : 'They can no longer sign in. Their complaints, feedback and history stay unchanged, and you can activate the account again at any time.',
        confirmLabel: 'Deactivate account',
        tone: 'danger',
      })
      if (!ok) return
    } else {
      const ok = await confirm({
        title: `Activate ${name}?`,
        message:
          row.role === 'officer'
            ? 'They can sign in again. Mark them available in Officer management when they should receive new work.'
            : 'They can sign in again with their existing password.',
        confirmLabel: 'Activate account',
        tone: 'primary',
      })
      if (!ok) return
    }
    setBusyId(row.id)
    try {
      if (row.is_active) {
        const result = await userService.remove(row.id)
        toast.success('Account deactivated', result?.detail ?? `${name} can no longer sign in.`)
      } else {
        await userService.update(row.id, { is_active: true })
        toast.success('Account activated', `${name} can sign in again.`)
      }
      users.refetch()
    } catch (error) {
      toast.error(row.is_active ? 'Could not deactivate the account' : 'Could not activate the account', getErrorMessage(error))
    } finally {
      setBusyId(null)
    }
  }

  const columns = [
    {
      key: 'name',
      header: 'User',
      sortable: true,
      sortKey: 'first_name',
      className: 'max-w-72',
      render: (row) => <PersonCell name={row.full_name || row.email} avatar={row.avatar} secondary={row.email} />,
    },
    { key: 'role', header: 'Role', render: (row) => <RoleBadge role={row.role} /> },
    {
      key: 'phone',
      header: 'Phone',
      hideOnMobile: true,
      render: (row) => (row.phone ? <span className="whitespace-nowrap tabular">{row.phone}</span> : <span className="text-ink-3">—</span>),
    },
    {
      key: 'complaints',
      header: 'Complaints',
      align: 'right',
      sortable: true,
      sortKey: 'complaint_count',
      render: (row) => (
        <span className="whitespace-nowrap">
          <span className="font-semibold tabular">{formatNumber(row.complaint_count ?? 0)}</span>
          <span className="block text-[11px] text-ink-3">{row.role === 'officer' ? 'assigned' : 'reported'}</span>
        </span>
      ),
    },
    {
      key: 'points',
      header: 'Civic points',
      align: 'right',
      hideOnMobile: true,
      render: (row) =>
        row.role === 'citizen' ? <span className="font-semibold tabular">{formatNumber(row.civic_points ?? 0)}</span> : <span className="text-ink-3">—</span>,
    },
    {
      key: 'joined',
      header: 'Joined',
      sortable: true,
      sortKey: 'date_joined',
      hideOnMobile: true,
      render: (row) => (
        <time dateTime={row.date_joined} className="whitespace-nowrap tabular">
          {formatDate(row.date_joined)}
        </time>
      ),
    },
    {
      key: 'login',
      header: 'Last sign-in',
      sortable: true,
      sortKey: 'last_login',
      hideOnMobile: true,
      render: (row) =>
        row.last_login ? (
          <time dateTime={row.last_login} title={formatDateTime(row.last_login)} className="whitespace-nowrap text-ink-2">
            {timeAgo(row.last_login)}
          </time>
        ) : (
          <span className="text-ink-3">Never</span>
        ),
    },
    { key: 'status', header: 'Status', render: (row) => <ActiveBadge active={row.is_active} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <DropdownMenu
          label={`Actions for ${row.full_name || row.email}`}
          trigger={<IconButton icon={MoreHorizontal} label={`Actions for ${row.full_name || row.email}`} size="sm" loading={busyId === row.id} />}
          items={[
            { label: 'View details', icon: Eye, onClick: () => openDetails(row) },
            row.role === 'officer'
              ? { label: 'Open in officer management', icon: HardHat, to: `/admin/officers?search=${encodeURIComponent(row.email)}` }
              : null,
            { divider: true },
            row.is_active
              ? {
                  label: 'Deactivate account',
                  icon: PowerOff,
                  danger: true,
                  disabled: row.id === me?.id,
                  description: row.id === me?.id ? 'This is your own account' : undefined,
                  onClick: () => toggleActive(row),
                }
              : { label: 'Activate account', icon: Power, onClick: () => toggleActive(row) },
          ].filter(Boolean)}
        />
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="Users"
        description="Every account on CivicAI. Open a person to see their profile and activity, or deactivate an account without losing its history."
        actions={
          <Button
            leftIcon={UserPlus}
            onClick={() => {
              setCreateSession((value) => value + 1)
              setCreateOpen(true)
            }}
          >
            Create user
          </Button>
        }
      />

      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <SearchInput
          value={values.search}
          onSearch={(search) => setValues({ search })}
          placeholder="Search name, email or phone"
          label="Search users"
          className="sm:max-w-sm sm:flex-1"
        />
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Select
            aria-label="Role"
            value={values.role}
            onChange={(event) => setValues({ role: event.target.value })}
            options={ROLE_FILTER}
            containerClassName="sm:w-44"
            className={values.role ? 'border-primary' : undefined}
          />
          <Select
            aria-label="Account status"
            value={values.is_active}
            onChange={(event) => setValues({ is_active: event.target.value })}
            options={ACTIVE_FILTER}
            containerClassName="sm:w-40"
            className={values.is_active ? 'border-primary' : undefined}
          />
        </div>
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={reset}>
            Clear filters
          </Button>
        ) : null}
      </div>

      <SummaryLine className="mb-2" count={users.data?.count} noun="user" loading={users.loading && Boolean(users.data)} />

      {users.error && !users.data ? (
        <ErrorState title="Users could not be loaded" error={users.error} onRetry={() => users.refetch()} />
      ) : (
        <DataTable
          caption="Users"
          className="relative"
          columns={columns}
          data={rows}
          loading={users.loading}
          rowKey="id"
          sort={values.ordering}
          onSortChange={(ordering) => setValues({ ordering })}
          onRowClick={openDetails}
          empty={
            filtered ? (
              <EmptyState
                bordered={false}
                icon={SearchX}
                title="No users match"
                description="Try another name or email, or clear the role and status filters."
                action={
                  <Button variant="outline" onClick={reset}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState bordered={false} icon={Users} title="No users yet" description="Accounts appear here as people register or you create them." />
            )
          }
          mobileCard={(row) => (
            <div className="flex items-start justify-between gap-3 p-4">
              <PersonCell name={row.full_name || row.email} avatar={row.avatar} secondary={row.email} size="md" />
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <RoleBadge role={row.role} />
                <ActiveBadge active={row.is_active} />
                <span className="text-xs text-ink-3 tabular">
                  {formatNumber(row.complaint_count ?? 0)} {row.role === 'officer' ? 'assigned' : 'reported'}
                </span>
              </div>
            </div>
          )}
        />
      )}

      <ListPagination data={users.data} page={page} pageSize={PAGE_SIZE} onPageChange={setPage} />

      <UserDrawer
        open={drawerOpen && Boolean(selected)}
        onClose={() => setDrawerOpen(false)}
        user={selected}
        isSelf={selected?.id === me?.id}
        busy={busyId === selected?.id}
        onToggleActive={toggleActive}
      />
      <CreateUserModal
        key={createSession}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false)
          reset()
          users.refetch()
        }}
      />
    </>
  )
}
