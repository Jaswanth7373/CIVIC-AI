/**
 * useOpenNotification - what happens when a person chooses a notification: it is marked read (through
 * NotificationContext, so the topbar bell count stays in sync) and, when it carries an in-app link such as
 * "/citizen/complaints/638", the app navigates there. Links are only followed when they are internal paths.
 *
 *   const open = useOpenNotification({ onRead: (updated) => ... })
 *   <NotificationItem onOpen={open} ... />
 *
 * `onRead(updated)` receives the server's updated Notification so a list can patch its row in place.
 * Resolves to true when the app navigated away.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useNotifications } from '@/hooks/useNotifications'
import { useToast } from '@/hooks/useToast'
import { getErrorMessage } from '@/utils/errors'

export function isInternalLink(link) {
  return typeof link === 'string' && link.startsWith('/') && !link.startsWith('//')
}

export function useOpenNotification({ onRead } = {}) {
  const navigate = useNavigate()
  const toast = useToast()
  const { markRead } = useNotifications()
  const onReadRef = useRef(onRead)

  useEffect(() => {
    onReadRef.current = onRead
  })

  return useCallback(
    async (notification) => {
      if (!notification) return false
      const follow = isInternalLink(notification.link)
      if (!notification.is_read) {
        const pending = markRead(notification.id)
          .then((updated) => onReadRef.current?.(updated ?? { ...notification, is_read: true }))
          .catch((error) => toast.error('Could not mark the notification as read', getErrorMessage(error)))
        // Navigating right away keeps the click snappy; the read state settles in the background.
        if (!follow) await pending
      }
      if (follow) {
        navigate(notification.link)
        return true
      }
      return false
    },
    [markRead, navigate, toast],
  )
}

export default useOpenNotification
