/**
 * NotificationItem - one in-app notification as a list row (notifications page, citizen dashboard).
 *
 * Props:
 * - notification: Notification `{id, title, message, notification_type, type_display, level, complaint,
 *   complaint_number, link, is_read, read_at, created_at}`
 * - onOpen(notification): the row was chosen (mark read + follow its link); the whole row is the hit area
 * - onMarkRead(notification) / onDelete(notification): optional row actions (shown on the full page only)
 * - busy: 'read' | 'delete' | null - which row action is in flight (spinner on that button)
 * - compact: dashboard variant (smaller chip, no row actions, message clamped to one line)
 * - entranceIndex: position in the first batch the list showed - the row fades in after a short cascade
 *   delay (first load only; later rows simply appear)
 *
 * The row is an <li> with ONE stretched button (the title) covering it, so the action buttons beside it are
 * siblings rather than nested interactive elements. Unread rows carry a dot plus a visually hidden "Unread"
 * label, so the state never rests on colour alone. Warning / critical levels add a labelled badge.
 *
 * Unread rows also carry a road-marking yellow bar on their left edge; when the row is read (one at a time
 * or with "Mark all as read") the bar retracts and the dot shrinks away instead of vanishing.
 */
import { Check, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { resolveTone, toneChip } from '@/components/ui/tones'
import { cn } from '@/utils/cn'
import { NOTIFICATION_LEVEL_META, getNotificationMeta } from '@/utils/constants'
import { formatDateTime, timeAgo } from '@/utils/format'

export function NotificationItem({
  notification,
  onOpen,
  onMarkRead,
  onDelete,
  busy = null,
  compact = false,
  entranceIndex,
  className,
}) {
  const meta = getNotificationMeta(notification.notification_type)
  const Icon = meta.icon
  const unread = !notification.is_read
  const level = NOTIFICATION_LEVEL_META[notification.level]
  const showLevel = level && (notification.level === 'warning' || notification.level === 'critical')
  const hasActions = !compact && (onMarkRead || onDelete)
  // The type label only adds information when it differs from the title ("Department assigned" twice is noise).
  const typeLabel = meta.label && meta.label.toLowerCase() !== String(notification.title ?? '').toLowerCase() ? meta.label : ''
  const showMeta = !compact && (notification.complaint_number || showLevel || typeLabel || hasActions)

  const entering = typeof entranceIndex === 'number'
  return (
    <li
      className={cn(
        'group relative flex gap-3 transition-colors duration-300 hover:bg-surface-2 has-[button:focus-visible]:bg-surface-2',
        compact ? 'px-4 py-3' : 'px-4 py-3.5 sm:px-5',
        unread && 'bg-primary-soft/35',
        entering && 'animate-row-in motion-reduce:animate-none',
        className,
      )}
      style={entering ? { animationDelay: `${Math.min(entranceIndex, 9) * 40}ms` } : undefined}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-2.5 left-0 w-[3px] origin-center rounded-r-full bg-marking-500 transition-[scale,opacity] duration-300 ease-standard',
          unread ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0',
        )}
      />
      <span
        aria-hidden
        className={cn(
          'grid shrink-0 place-items-center rounded-full',
          compact ? 'size-8' : 'size-9',
          toneChip[resolveTone(meta.tone)],
        )}
      >
        <Icon className={compact ? 'size-4' : 'size-[18px]'} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={() => onOpen?.(notification)}
            className={cn(
              'min-w-0 text-left text-sm text-ink outline-hidden after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus',
              unread ? 'font-semibold' : 'font-medium',
            )}
          >
            {unread ? <span className="sr-only">Unread: </span> : null}
            {notification.title}
          </button>
          <span className="flex shrink-0 items-center gap-2 pt-0.5">
            <time
              dateTime={notification.created_at}
              title={formatDateTime(notification.created_at)}
              className="whitespace-nowrap text-xs text-ink-3 tabular"
            >
              {timeAgo(notification.created_at)}
            </time>
            <span
              aria-hidden
              className={cn(
                'size-2 rounded-full bg-signal-500 transition-[scale,opacity] duration-300 ease-spring-bounce',
                unread ? 'scale-100 opacity-100' : 'scale-0 opacity-0',
              )}
            />
          </span>
        </div>
        {notification.message ? (
          <p className={cn('mt-0.5 text-ink-2', compact ? 'line-clamp-1 text-xs' : 'line-clamp-2 text-[13px] leading-relaxed')}>
            {notification.message}
          </p>
        ) : null}
        {showMeta ? (
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {showLevel ? (
                <Badge tone={level.tone} size="sm" icon={level.icon}>
                  {level.label}
                </Badge>
              ) : null}
              {typeLabel ? <span className="text-xs text-ink-3">{typeLabel}</span> : null}
              {notification.complaint_number ? (
                <span className="text-xs font-semibold text-ink-2 tabular">{notification.complaint_number}</span>
              ) : null}
            </div>
            {hasActions ? (
              <div className="relative z-10 -my-1 ml-auto flex shrink-0 items-center gap-0.5 sm:opacity-70 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                {onMarkRead && unread ? (
                  <IconButton
                    icon={Check}
                    size="sm"
                    label={`Mark "${notification.title}" as read`}
                    loading={busy === 'read'}
                    disabled={Boolean(busy)}
                    onClick={() => onMarkRead(notification)}
                  />
                ) : null}
                {onDelete ? (
                  <IconButton
                    icon={Trash2}
                    size="sm"
                    label={`Delete notification "${notification.title}"`}
                    loading={busy === 'delete'}
                    disabled={Boolean(busy)}
                    onClick={() => onDelete(notification)}
                    className="hover:text-signal-600 dark:hover:text-signal-300"
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  )
}

export default NotificationItem
