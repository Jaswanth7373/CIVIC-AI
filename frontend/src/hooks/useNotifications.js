/**
 * Notification bell state: `{ unreadCount, recent, recentLoaded, loadingRecent, refresh(), loadRecent(),
 * markRead(id), markAllRead(), remove(id) }`.
 */
import { useContext } from 'react'
import { NotificationContext } from '@/context/contexts'

export function useNotifications() {
  const context = useContext(NotificationContext)
  if (!context) throw new Error('useNotifications() must be used inside <NotificationProvider>.')
  return context
}

export default useNotifications
