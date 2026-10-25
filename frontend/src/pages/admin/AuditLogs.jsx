/**
 * Audit logs (admin) - who did what, when and from where.
 *
 * Data: GET /audit-logs/ (filters `action`, `entity_type`, `date_from`, `date_to` (YYYY-MM-DD), `search`;
 * paginated, newest first) - every filter and the page live in the URL. Each row expands to show its
 * `changes` JSON as a readable old -> new diff (ChangesDiff). Entities that have an admin page link to it.
 * Phones get the same entries as cards with the same disclosure.
 */
import { Bot, ChevronDown, ScrollText, SearchX, UserRoundX } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, EmptyState, ErrorState, FormField, Input, PageHeader, SearchInput, Select, Skeleton } from '@/components/ui'
import { useApi } from '@/hooks/useApi'
import { systemService } from '@/services'
import { cn } from '@/utils/cn'
import { AUDIT_ACTION_OPTIONS } from '@/utils/constants'
import { formatDate, formatDateInput, formatDateTime, timeAgo } from '@/utils/format'
import { ChangesDiff } from './manage/audit/ChangesDiff'
import { ENTITY_TYPES, changesLabel, entityLabel, entityPath, getActionMeta, isSnapshotAction } from './manage/audit/auditMeta'
import { ListPagination, PersonCell, SummaryLine } from './manage/shared/Controls'
import { compactParams, toList } from './manage/shared/listUtils'
import { useUrlParams } from './manage/shared/useUrlParams'

const PAGE_SIZE = 25
const DEFAULTS = { search: '', action: '', entity_type: '', date_from: '', date_to: '' }

/** Sign-in events without an actor come from someone who was not signed in (e.g. a failed login). */
const ANONYMOUS_ACTIONS = new Set(['login', 'logout', 'register', 'password_change'])

function Actor({ actor, action }) {
  if (!actor) {
    const anonymous = ANONYMOUS_ACTIONS.has(action)
    const Icon = anonymous ? UserRoundX : Bot
    return (
      <span className="flex items-center gap-2.5 text-ink-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sunken text-ink-3">
          <Icon aria-hidden className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block font-semibold text-ink">{anonymous ? 'Unknown visitor' : 'CivicAI system'}</span>
          <span className="block text-xs text-ink-3">{anonymous ? 'Not signed in' : 'Automatic'}</span>
        </span>
      </span>
    )
  }
  return <PersonCell name={actor.full_name || actor.email} avatar={actor.avatar} secondary={actor.role ? `${actor.role.charAt(0).toUpperCase()}${actor.role.slice(1)}` : actor.email} />
}

function ActionBadge({ entry }) {
  const meta = getActionMeta(entry.action, entry.action_display)
  return (
    <Badge tone={meta.tone} icon={meta.icon} size="sm">
      {meta.label}
    </Badge>
  )
}

function EntityCell({ entry }) {
  const path = entityPath(entry.entity_type, entry.entity_id)
  const label = entityLabel(entry.entity_type)
  const content = (
    <>
      <span className="block">{label || '—'}</span>
      {entry.entity_id ? <span className="block text-xs text-ink-3 tabular">#{entry.entity_id}</span> : null}
    </>
  )
  return path ? (
    <Link to={path} className="block whitespace-nowrap font-medium text-primary-ink hover:underline">
      {content}
    </Link>
  ) : (
    <span className="block whitespace-nowrap text-ink">{content}</span>
  )
}

/** "3 changes" / "8 fields" disclosure of an entry's recorded data (entries without any have no toggle). */
function ToggleButton({ label, expanded, onToggle, controls }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controls}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary-soft pointer-coarse:min-h-11"
    >
      {label}
      <ChevronDown aria-hidden className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
    </button>
  )
}

function TableSkeleton() {
  return (
    <div aria-hidden className="space-y-px overflow-hidden rounded-xl border border-line bg-surface">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex gap-4 border-b border-line px-4 py-4 last:border-0">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  )
}

export default function AuditLogs() {
  const { values, setValues, page, setPage, reset } = useUrlParams(DEFAULTS)
  const [expanded, setExpanded] = useState(() => new Set())
  const logs = useApi(() => systemService.auditLogs(compactParams({ ...values, page, page_size: PAGE_SIZE })), [values, page])
  const rows = toList(logs.data)
  const filtered = Object.values(values).some(Boolean)
  const today = formatDateInput(new Date())

  const toggle = (id) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const empty = filtered ? (
    <EmptyState
      icon={SearchX}
      title="No audit entries match"
      description="Widen the date range, choose another action or clear the search."
      action={
        <Button variant="outline" onClick={reset}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState icon={ScrollText} title="Nothing has been logged yet" description="Sign-ins, assignments, AI overrides and configuration changes appear here." />
  )

  return (
    <>
      <PageHeader
        title="Audit logs"
        description="Every sensitive action on the platform, with the person, the time and the exact values that changed."
      />

      <section aria-label="Filters" className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))_auto_auto] lg:items-end">
        <FormField label="Search" htmlFor="audit-search" className="col-span-2 lg:col-span-1">
          <SearchInput
            id="audit-search"
            value={values.search}
            onSearch={(search) => setValues({ search })}
            placeholder="Description, entity id or person"
            label="Search audit logs"
          />
        </FormField>
        <FormField label="Action" htmlFor="audit-action">
          <Select
            id="audit-action"
            placeholder="Any action"
            value={values.action}
            onChange={(event) => setValues({ action: event.target.value })}
            options={AUDIT_ACTION_OPTIONS}
            className={values.action ? 'border-primary' : undefined}
          />
        </FormField>
        <FormField label="Entity" htmlFor="audit-entity">
          <Select
            id="audit-entity"
            placeholder="Any entity"
            value={values.entity_type}
            onChange={(event) => setValues({ entity_type: event.target.value })}
            options={ENTITY_TYPES}
            className={values.entity_type ? 'border-primary' : undefined}
          />
        </FormField>
        <FormField label="From" htmlFor="audit-from">
          <Input
            id="audit-from"
            type="date"
            value={values.date_from}
            max={values.date_to || today}
            onChange={(event) => setValues({ date_from: event.target.value })}
            className={cn('lg:w-40', values.date_from && 'border-primary')}
          />
        </FormField>
        <FormField label="To" htmlFor="audit-to">
          <Input
            id="audit-to"
            type="date"
            value={values.date_to}
            min={values.date_from || undefined}
            max={today}
            onChange={(event) => setValues({ date_to: event.target.value })}
            className={cn('lg:w-40', values.date_to && 'border-primary')}
          />
        </FormField>
      </section>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <SummaryLine count={logs.data?.count} noun="entry" plural="entries" loading={logs.loading && Boolean(logs.data)}>
          {values.date_from || values.date_to ? (
            <span className="text-ink-3">
              {values.date_from ? `from ${formatDate(values.date_from)}` : ''}
              {values.date_from && values.date_to ? ' ' : ''}
              {values.date_to ? `until ${formatDate(values.date_to)}` : ''}
            </span>
          ) : null}
        </SummaryLine>
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={reset}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {logs.error && !logs.data ? (
        <ErrorState title="Audit logs could not be loaded" error={logs.error} onRetry={() => logs.refetch()} />
      ) : logs.loading && !logs.data ? (
        <TableSkeleton />
      ) : !rows.length ? (
        empty
      ) : (
        <div className="relative min-w-0 overflow-hidden rounded-xl border border-line bg-surface" aria-busy={logs.loading || undefined}>
          {logs.loading ? (
            <div aria-hidden className="h-1 overflow-hidden bg-sunken">
              <div className="lane-line-x animate-lane h-full w-full" />
            </div>
          ) : null}

          <ul className="divide-y divide-line md:hidden" aria-label="Audit entries">
            {rows.map((entry) => {
              const label = changesLabel(entry.changes, entry.action)
              const open = Boolean(label) && expanded.has(entry.id)
              return (
                <li key={entry.id} className="space-y-2.5 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <Actor actor={entry.actor} action={entry.action} />
                    <ActionBadge entry={entry} />
                  </div>
                  <p className="text-sm text-ink">{entry.description}</p>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
                    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                      <time dateTime={entry.created_at} title={formatDateTime(entry.created_at)} className="tabular">
                        {formatDateTime(entry.created_at)}
                      </time>
                      <span>
                        {entityLabel(entry.entity_type)}
                        {entry.entity_id ? ` #${entry.entity_id}` : ''}
                      </span>
                      {entry.ip_address ? <span className="tabular">IP {entry.ip_address}</span> : null}
                    </span>
                    {label ? (
                      <ToggleButton label={label} expanded={open} onToggle={() => toggle(entry.id)} controls={`audit-changes-card-${entry.id}`} />
                    ) : null}
                  </div>
                  {open ? (
                    <div id={`audit-changes-card-${entry.id}`} className="rounded-lg bg-surface-2 p-3">
                      <ChangesDiff changes={entry.changes} snapshot={isSnapshotAction(entry.action)} />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>

          <div className="scrollbar-thin relative hidden overflow-x-auto md:block">
            <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
              <caption className="sr-only">Audit log entries</caption>
              <thead className="bg-surface-2">
                <tr className="border-b border-line text-xs font-semibold text-ink-2">
                  <th scope="col" className="whitespace-nowrap px-4 py-2.5">Time</th>
                  <th scope="col" className="px-4 py-2.5">Actor</th>
                  <th scope="col" className="px-4 py-2.5">Action</th>
                  <th scope="col" className="px-4 py-2.5">Entity</th>
                  <th scope="col" className="px-4 py-2.5">Description</th>
                  <th scope="col" className="px-4 py-2.5">IP address</th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    <span className="sr-only">Changes</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => {
                  const label = changesLabel(entry.changes, entry.action)
                  const open = Boolean(label) && expanded.has(entry.id)
                  return (
                    <Fragment key={entry.id}>
                      <tr
                        onClick={(event) => {
                          if (label && !event.target.closest('a, button')) toggle(entry.id)
                        }}
                        className={cn(
                          'border-b border-line align-top transition-colors',
                          label && 'cursor-pointer hover:bg-surface-2',
                          open && 'bg-surface-2',
                        )}
                      >
                        <td className="whitespace-nowrap px-4 py-3">
                          <time dateTime={entry.created_at} className="block tabular text-ink">
                            {formatDateTime(entry.created_at)}
                          </time>
                          <span className="block text-xs text-ink-3">{timeAgo(entry.created_at)}</span>
                        </td>
                        <td className="max-w-56 px-4 py-3">
                          <Actor actor={entry.actor} action={entry.action} />
                        </td>
                        <td className="px-4 py-3">
                          <ActionBadge entry={entry} />
                        </td>
                        <td className="px-4 py-3">
                          <EntityCell entry={entry} />
                        </td>
                        <td className="min-w-64 px-4 py-3 text-ink">{entry.description}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-2 tabular">{entry.ip_address || <span className="text-ink-3">Not recorded</span>}</td>
                        <td className="px-4 py-2 text-right">
                          {label ? (
                            <ToggleButton label={label} expanded={open} onToggle={() => toggle(entry.id)} controls={`audit-changes-${entry.id}`} />
                          ) : null}
                        </td>
                      </tr>
                      {open ? (
                        <tr id={`audit-changes-${entry.id}`} className="border-b border-line bg-surface-2">
                          <td colSpan={7} className="px-4 pb-4 pt-1">
                            <div className="rounded-lg border border-line bg-surface p-3.5">
                              <ChangesDiff changes={entry.changes} snapshot={isSnapshotAction(entry.action)} />
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ListPagination data={logs.data} page={page} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </>
  )
}
