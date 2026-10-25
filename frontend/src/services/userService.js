/**
 * User management endpoints (`/api/users/*`, admin only). Every function resolves to `response.data`.
 * Officers should be created through `officerService.create` so they also get an officer profile.
 */
import api from './api'

export const userService = {
  /** Paginated users with `complaint_count` and `civic_points`. Filters: role, is_active, search. */
  async list(params = {}, config = {}) {
    const { data } = await api.get('/users/', { params, ...config })
    return data
  },

  async get(id) {
    const { data } = await api.get(`/users/${id}/`)
    return data
  },

  async create(data) {
    const { data: body } = await api.post('/users/', data)
    return body
  },

  /** `{first_name, last_name, phone, is_active, role}` */
  async update(id, data) {
    const { data: body } = await api.patch(`/users/${id}/`, data)
    return body
  },

  /** Soft delete (sets is_active=false). Admins cannot delete themselves. */
  async remove(id) {
    const { data } = await api.delete(`/users/${id}/`)
    return data
  },
}

export default userService
