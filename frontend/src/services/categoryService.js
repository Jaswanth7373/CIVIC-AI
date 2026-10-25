/**
 * Civic category endpoints (`/api/categories/`). Non-paginated list. Every function resolves to `response.data`.
 * Categories are data, not code: admin-added categories (keywords, vision labels, routing) are used by the AI
 * engine without retraining.
 */
import api from './api'

export const categoryService = {
  /** `[CategoryOut]`. `{include_inactive: true}` (admin) also returns deactivated categories. */
  async list(params = {}, config = {}) {
    const { data } = await api.get('/categories/', { params, ...config })
    return data
  },

  async get(id) {
    const { data } = await api.get(`/categories/${id}/`)
    return data
  },

  /** Admin. The slug is generated from the name when omitted. */
  async create(data) {
    const { data: body } = await api.post('/categories/', data)
    return body
  },

  async update(id, data) {
    const { data: body } = await api.patch(`/categories/${id}/`, data)
    return body
  },

  /** Admin. Deactivates the category when complaints already use it, otherwise deletes it. */
  async remove(id) {
    const { data } = await api.delete(`/categories/${id}/`)
    return data
  },
}

export default categoryService
