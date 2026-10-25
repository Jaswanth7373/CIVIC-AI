/**
 * In-app notification endpoints (`/api/notifications/*`). Every function resolves to `response.data`.
 * NotificationContext polls `unreadCount` for the bell; the notifications page uses `list`.
 */
import api from './api'

export const notificationService = {
  /** Paginated `[Notification]`. `{is_read: true | false}` filters by read state. */
  async list(params = {}, config = {}) {
    const { data } = await api.get('/notifications/', { params, ...config })
    return data
  },

  /** `{count}` */
  async unreadCount(config = {}) {
    const { data } = await api.get('/notifications/unread-count/', config)
    return data
  },

  /** -> the updated Notification */
  async markRead(id) {
    const { data } = await api.post(`/notifications/${id}/read/`)
    return data
  },

  /** -> `{updated: n}` */
  async markAllRead() {
    const { data } = await api.post('/notifications/read-all/')
    return data
  },

  async remove(id) {
    const { data } = await api.delete(`/notifications/${id}/`)
    return data
  },
}

export default notificationService
