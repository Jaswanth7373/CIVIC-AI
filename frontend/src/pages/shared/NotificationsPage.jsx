/**
 * Notifications (/citizen/notifications, /officer/notifications, /admin/notifications).
 *
 * GET /api/notifications/ (paginated, the caller's own; `?is_read=false` for the Unread tab), grouped by day.
 * Choosing a notification marks it read and opens its link (e.g. the complaint it is about); each row can
 * also be marked read or deleted (with confirmation), and "Mark all as read" clears the unread count.
 * Mark-read, mark-all and delete go through NotificationContext, so the topbar bell and the mobile tab bar
 * update at the same time. The tab and page live in the URL (?tab=unread&page=2).
 *
 * Motion: the first rows to arrive fade in one after another (later pages and refreshes simply appear), and
 * reading a row retracts its road-marking unread bar.
 */
import { differenceInCalendarDays, format } from 'date-fns'
import { BellOff, CheckCheck, MapPinPlus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { PaginationBar } from './components/PaginationBar'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tabs } from '@/components/ui/Tabs'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { useConfirm } from '@/hooks/useConfirm'
import { useNotifications } from '@/hooks/useNotifications'
import { useToast } from '@/hooks/useToast'
import { notificationService } from '@/services/notificationService'
import { cn } from '@/utils/cn'
import { getErrorMessage, getErrorStatus } from '@/utils/errors'
import { formatNumber, toDate } from '@/utils/format'
import { NotificationItem } from './components/NotificationItem'
import { useOpenNotification } from './components/useOpenNotification'

const PAGE_SIZE = 20

const EMPTY_COPY = {
  citizen: 'Updates about your complaints appear here: the AI analysis, the officer assigned, progress on site and the fix.',
  officer: 'New assignments, critical complaints and reopened complaints from citizens appear here.',
  admin: 'Critical complaints, SLA breaches, hotspot alerts, manual review requests and negative feedback appear here.',
}

/** "Today", "Yesterday", "Monday" (this week) or "12 Oct 2026". */
function dayLabel(value, now = new Date()) {
  const date = toDate(value)
  if (!date) return 'Earlier'
  const days = differenceInCalendarDays(now, date)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return format(date, 'EEEE')
  return format(date, date.getFullYear() === now.getFullYear() ? 'd MMMM' : 'd MMMM yyyy')
}

function groupByDay(items) {
  const groups = []
  items.forEach((item) => {
    const label = dayLabel(item.created_at)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  })
  return groups
}

function ListSkeleton() {
  return (
    <ul aria-hidden className="divide-y divide-line">
      {Array.from({ length: 6 }, (_, index) => (
        <li key={index} className="flex gap-3 px-5 py-4">
          <Skeleton circle className="size-9 shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function NotificationsPage() {
  const { role } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const { unreadCount, markRead, markAllRead, remove } = useNotifications()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') === 'unread' ? 'unread' : 'all'
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '', 10) || 1)
  const [busy, setBusy] = useState({})
  const [markingAll, setMarkingAll] = useState(false)
  const [allCount, setAllCount] = useState(null)

  const { data, loading, error, refetch, setData } = useApi(
    () => notificationService.list({ page, page_size: PAGE_SIZE, ...(tab === 'unread' ? { is_read: false } : {}) }),
    [tab, page],
  )

  const rows = useMemo(() => data?.results ?? [], [data])
  const groups = useMemo(() => groupByDay(rows), [rows])
  // The rows of the first load play the entrance (by id, in display order); everything later just appears.
  const [entranceIds, setEntranceIds] = useState(null)
  if (entranceIds === null && rows.length) setEntranceIds(new Map(rows.slice(0, 10).map((row, index) => [row.id, index])))

  // Remember the size of the "All" list so its tab keeps a count while "Unread" is open.
  useEffect(() => {
    if (tab === 'all' && typeof data?.count === 'number') setAllCount(data.count)
  }, [tab, data])

  const setParams = useCallback(
    (next) => {
      setSearchParams((current) => {
        const params = new URLSearchParams(current)
        Object.entries(next).forEach(([key, value]) => {
          if (value === null || value === undefined || value === '' || (key === 'page' && Number(value) <= 1)) params.delete(key)
          else params.set(key, String(value))
        })
        return params
      })
    },
    [setSearchParams],
  )

  // A page number from an old link can be past the end (the list shrank): go back to the first page.
  const pageGone = getErrorStatus(error) === 404 && page > 1
  useEffect(() => {
    if (pageGone) setParams({ page: null })
  }, [pageGone, setParams])

  const patchRow = (updated) => {
    if (!updated?.id) return
    setData((current) =>
      current?.results
        ? { ...current, results: current.results.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)) }
        : current,
    )
  }

  const open = useOpenNotification({ onRead: patchRow })

  const handleMarkRead = async (notification) => {
    setBusy((current) => ({ ...current, [notification.id]: 'read' }))
    try {
      const updated = await markRead(notification.id)
      patchRow(updated ?? { ...notification, is_read: true })
      toast.success('Marked as read', notification.title)
    } catch (markError) {
      toast.error('Could not mark the notification as read', getErrorMessage(markError))
    } finally {
      setBusy((current) => ({ ...current, [notification.id]: null }))
    }
  }

  const handleDelete = async (notification) => {
    const ok = await confirm({
      title: 'Delete this notification?',
      message: `"${notification.title}" will be removed from your list. The complaint itself is not affected.`,
      confirmLabel: 'Delete notification',
      tone: 'danger',
    })
    if (!ok) return
    setBusy((current) => ({ ...current, [notification.id]: 'delete' }))
    try {
      await remove(notification.id)
      toast.success('Notification deleted')
      const remaining = rows.filter((item) => item.id !== notification.id)
      if (!remaining.length && page > 1) setParams({ page: page - 1 })
      else refetch()
    } catch (deleteError) {
      toast.error('Could not delete the notification', getErrorMessage(deleteError))
    } finally {
      setBusy((current) => ({ ...current, [notification.id]: null }))
    }
  }

  const handleMarkAll = async () => {
    setMarkingAll(true)
    try {
      const result = await markAllRead()
      const updated = Number(result?.updated) || 0
      toast.success('All notifications marked as read', updated ? `${formatNumber(updated)} updated.` : undefined)
      refetch()
    } catch (markError) {
      toast.error('Could not mark notifications as read', getErrorMessage(markError))
    } finally {
      setMarkingAll(false)
    }
  }

  const tabs = [
    { id: 'all', label: 'All', count: typeof allCount === 'number' ? allCount : undefined },
    { id: 'unread', label: 'Unread', count: unreadCount },
  ]

  const emptyState =
    tab === 'unread' ? (
      <EmptyState
        bordered={false}
        icon={CheckCheck}
        title="You are all caught up"
        description="There are no unread notifications. New updates will appear here as they happen."
        action={
          <Button variant="outline" onClick={() => setParams({ tab: null, page: null })}>
            Show all notifications
          </Button>
        }
      />
    ) : (
      <EmptyState
        bordered={false}
        icon={BellOff}
        title="No notifications yet"
        description={EMPTY_COPY[role] ?? EMPTY_COPY.citizen}
        action={
          role === 'citizen' ? (
            <Button variant="warning" leftIcon={MapPinPlus} to="/citizen/report">
              Report an issue
            </Button>
          ) : null
        }
      />
    )

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Notifications"
        description={
          unreadCount
            ? `${formatNumber(unreadCount)} unread. Choose a notification to open what it is about.`
            : 'Every update about your work and complaints, newest first.'
        }
        actions={
          <Button variant="outline" leftIcon={CheckCheck} loading={markingAll} disabled={!unreadCount} onClick={handleMarkAll}>
            Mark all as read
          </Button>
        }
      />

      <Card className="overflow-clip">
        <Tabs
          label="Notification filter"
          tabs={tabs}
          value={tab}
          onChange={(next) => setParams({ tab: next === 'all' ? null : next, page: null })}
          className="px-3 sm:px-4"
        />
        {error && !data && !pageGone ? (
          <ErrorState bordered={false} title="Notifications could not be loaded" error={error} onRetry={refetch} />
        ) : !data ? (
          <ListSkeleton />
        ) : rows.length ? (
          <div className={cn(loading && 'opacity-60 transition-opacity')} aria-busy={loading || undefined}>
            {groups.map((group) => (
              <section key={group.label} aria-label={group.label}>
                <h2 className="sticky top-16 z-10 border-b border-line bg-surface-2/95 px-4 py-1.5 text-xs font-semibold text-ink-3 backdrop-blur sm:px-5">
                  {group.label}
                </h2>
                <ul className="divide-y divide-line">
                  {group.items.map((notification) => (
                    <NotificationItem
                      key={notification.id}
                      notification={notification}
                      onOpen={open}
                      onMarkRead={handleMarkRead}
                      onDelete={handleDelete}
                      busy={busy[notification.id] ?? null}
                      entranceIndex={entranceIds?.get(notification.id)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          emptyState
        )}
        {data && rows.length ? (
          <div className="border-t border-line px-4 py-3 sm:px-5">
            <PaginationBar
              page={data.page ?? page}
              totalPages={data.total_pages ?? 1}
              count={data.count}
              pageSize={data.page_size ?? PAGE_SIZE}
              onPageChange={(next) => {
                setParams({ page: next })
                window.scrollTo({ top: 0 })
              }}
            />
          </div>
        ) : null}
      </Card>
    </div>
  )
}
