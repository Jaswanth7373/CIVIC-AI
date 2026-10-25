import { Bell, BellOff, CheckCheck } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, EmptyState, IconButton, Popover, Skeleton } from '@/components/ui'
import { resolveTone, toneChip } from '@/components/ui/tones'
import { useAuth } from '@/hooks/useAuth'
import { useNotifications } from '@/hooks/useNotifications'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/utils/cn'
import { getNotificationMeta } from '@/utils/constants'
import { getErrorMessage } from '@/utils/errors'
import { timeAgo } from '@/utils/format'

/**
 * How many times the bell should have swung: +1 whenever the unread count rises after the first count of the
 * session has arrived (a notification that came in while the page was open). The count's first arrival, and
 * any fall (notifications read), never swing it.
 */
function useBellSwings(unreadCount, recentLoaded) {
  const [seen, setSeen] = useState({ count: unreadCount, swings: 0 })
  if (seen.count !== unreadCount) {
    // Adjusting state while rendering (React's documented pattern for "react to a changed value").
    setSeen({ count: unreadCount, swings: seen.swings + (recentLoaded && unreadCount > seen.count ? 1 : 0) })
  }
  return seen.swings
}

/**
 * Topbar bell: unread count badge and a dropdown with the 5 latest notifications, "Mark all read" and
 * "View all". Opening the dropdown refreshes the list and focuses the newest notification; choosing one marks
 * it read and opens its link (the complaint it is about). Tab / Shift+Tab leave the dropdown in the top bar's
 * own order (Popover).
 *
 * Motion: when a new notification arrives while the page is open (the polled unread count rises), the bell
 * swings on its hook - a decaying rock, about a second - and the count bubble pops. Still with reduced motion.
 */
export function NotificationBell({ className }) {
  const { role } = useAuth()
  const { unreadCount, recent, recentLoaded, loadingRecent, loadRecent, markRead, markAllRead } = useNotifications()
  const navigate = useNavigate()
  const toast = useToast()
  const allPath = `/${role}/notifications`
  const swings = useBellSwings(unreadCount, recentLoaded)

  const handleMarkAll = async () => {
    try {
      await markAllRead()
    } catch (error) {
      toast.error("Couldn't mark notifications as read", getErrorMessage(error))
    }
  }

  const open = (notification, close) => {
    close()
    if (!notification.is_read) markRead(notification.id).catch(() => {})
    const target = typeof notification.link === 'string' && notification.link.startsWith('/') ? notification.link : allPath
    navigate(target)
  }

  return (
    <Popover
      label="Notifications"
      placement="bottom-end"
      className={className}
      // Open on the newest notification (or the labelled panel while the list loads), never on "Mark all read":
      // a second Enter must not mark everything read.
      initialFocus={(panel) => panel.querySelector('[data-notification-item]')}
      onOpenChange={(isOpen) => {
        if (isOpen) loadRecent()
      }}
      trigger={
        <IconButton
          // Re-keyed on every new arrival, so the swing plays again for each one.
          icon={<Bell key={swings} aria-hidden className={cn('size-5 origin-[50%_12%]', swings > 0 && 'animate-bell-ring')} />}
          label={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}
          badge={unreadCount}
        />
      }
      panelClassName="w-[min(24rem,calc(100vw-1rem))]"
    >
      {({ close }) => (
        <>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <p className="font-display text-sm font-bold text-ink">Notifications</p>
            <Button variant="link" size="sm" leftIcon={CheckCheck} onClick={handleMarkAll} disabled={!unreadCount}>
              Mark all read
            </Button>
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {loadingRecent && !recentLoaded ? (
              <ul aria-hidden className="divide-y divide-line">
                {[0, 1, 2].map((index) => (
                  <li key={index} className="flex gap-3 px-4 py-3">
                    <Skeleton circle className="size-8 shrink-0" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-2/3" />
                      <Skeleton className="h-3 w-full" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : recent.length ? (
              <ul className="divide-y divide-line">
                {recent.map((notification) => {
                  const meta = getNotificationMeta(notification.notification_type)
                  const Icon = meta.icon
                  return (
                    <li key={notification.id}>
                      <button
                        type="button"
                        data-notification-item=""
                        onClick={() => open(notification, close)}
                        className={cn(
                          'flex w-full gap-3 px-4 py-3 text-left transition-colors duration-150 ease-standard hover:bg-surface-2 focus-visible:-outline-offset-2 dark:hover:bg-white/[0.05]',
                          !notification.is_read && 'bg-primary-soft/40',
                        )}
                      >
                        <span className={cn('grid size-8 shrink-0 place-items-center rounded-full', toneChip[resolveTone(meta.tone)])}>
                          <Icon aria-hidden className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start justify-between gap-2">
                            <span className={cn('text-sm text-ink', !notification.is_read ? 'font-semibold' : 'font-medium')}>
                              {notification.title}
                            </span>
                            {!notification.is_read ? (
                              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-signal-500">
                                <span className="sr-only">Unread</span>
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 line-clamp-2 block text-xs text-ink-2">{notification.message}</span>
                          <span className="mt-1 block text-[11px] text-ink-3">{timeAgo(notification.created_at)}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <EmptyState
                bordered={false}
                compact
                icon={BellOff}
                titleAs="p"
                title="You're all caught up"
                description="Updates about complaints will appear here."
              />
            )}
          </div>
          <div className="border-t border-line p-2">
            <Button
              variant="ghost"
              fullWidth
              onClick={() => {
                close()
                navigate(allPath)
              }}
            >
              View all
            </Button>
          </div>
        </>
      )}
    </Popover>
  )
}

export default NotificationBell
